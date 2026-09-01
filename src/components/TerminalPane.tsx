import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Base64, ClipboardAddon, type ClipboardSelectionType } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import {
  Channel,
  detachPty,
  openPty,
  readClipboardText,
  resizePty,
  writeClipboardText,
  writePty,
} from '../ipc/bridge';
import {
  MAX_PASTE_CHARS,
  describeSize,
  normalizeCopyText,
  sanitizePasteText,
} from '../lib/clipboard';
import { appOwnsKey, terminalKeyAction } from '../lib/keys';
import { registerTerminalClipboard, terminalClipboard } from '../lib/terminalRegistry';
import { useStore } from '../state/store';
import type { Pane, PtyExitEvent } from '../state/types';

/** 디자인 터미널 색상. */
const THEME = {
  background: '#1b1a18',
  foreground: '#eceae4',
  cursor: '#d99b74',
  cursorAccent: '#1b1a18',
  selectionBackground: '#413b33',
  // 우클릭 메뉴가 포커스를 가져가도 선택 영역이 보여야 한다 (xterm 기본값은 회색이라 튄다).
  selectionInactiveBackground: '#332f29',
  black: '#33312b',
  red: '#e08b73',
  green: '#8fc98a',
  yellow: '#e0b567',
  blue: '#7fa8d9',
  magenta: '#b99ae0',
  cyan: '#7fc9c2',
  white: '#eceae4',
  brightBlack: '#9b968c',
  brightRed: '#eda28c',
  brightGreen: '#a6d9a1',
  brightYellow: '#edc77f',
  brightBlue: '#9cc0e8',
  brightMagenta: '#cbb2ec',
  brightCyan: '#9bd8d2',
  brightWhite: '#faf9f5',
};

/**
 * OSC 52 의 시스템 클립보드 선택자.
 *
 * `ClipboardSelectionType` 은 ambient `const enum` 이라 `isolatedModules` 아래에서는 값으로
 * 가져올 수 없다. 타입만 빌려 오고 값은 리터럴로 쓴다.
 */
const SYSTEM_SELECTION = 'c' as ClipboardSelectionType;

export function TerminalPane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const refresh = useStore((s) => s.refresh);

  // 터미널 수명은 패널 id 에 묶인다. 스냅샷이 갱신돼도 다시 만들지 않는다.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const flash = (msg: string) => useStore.getState().flash(msg);

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: "'Noto Sans Mono', 'Noto Sans KR', monospace",
      fontSize: pane.zoom,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8192,
      theme: THEME,
      // 한글 등 넓은 글자의 칸 수를 정확히 세도록 unicode 11 표를 쓴다.
      windowsPty: { backend: 'conpty' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';

    // OSC 52 — ssh·tmux·vim 안에서 복사한 내용이 윈도우 클립보드까지 오게 한다.
    term.loadAddon(
      new ClipboardAddon(new Base64(), {
        // 원격이 내 클립보드를 **읽는** 것은 막는다. 유출 경로가 된다.
        readText: () => '',
        writeText: (selection, data) =>
          selection === SYSTEM_SELECTION ? writeClipboardText(data).catch(() => {}) : undefined,
      }),
    );

    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL 이 없으면 기본 DOM 렌더러로 조용히 물러난다.
    }
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const copySelection = async () => {
      const text = normalizeCopyText(term.getSelection());
      if (!text) {
        flash('선택한 내용이 없습니다');
        return;
      }
      try {
        await writeClipboardText(text);
        // 선택을 지워야 다음 Ctrl+C 가 다시 실행 중인 명령을 끊는다.
        term.clearSelection();
        flash(`${text.length}자 복사됨`);
      } catch {
        flash('클립보드에 복사할 수 없습니다');
      }
    };

    // 클립보드 읽기는 비동기지만 붙여넣기끼리의 순서는 체인으로 지킨다.
    let pasteChain: Promise<void> = Promise.resolve();
    const pasteClipboard = () => {
      pasteChain = pasteChain.then(async () => {
        const raw = await readClipboardText();
        if (disposed || !raw) return;
        if (raw.length > MAX_PASTE_CHARS) {
          flash(`클립보드 내용이 너무 큽니다 (${describeSize(raw.length)}) — 붙여넣지 않았습니다`);
          return;
        }
        // 괄호 붙여넣기 모드는 xterm 이 알아서 감싼다 — 셸이 타이핑과 구분할 수 있게.
        term.paste(sanitizePasteText(raw));
      });
    };

    const unregisterClipboard = registerTerminalClipboard(pane.id, {
      copy: copySelection,
      paste: pasteClipboard,
    });

    term.attachCustomKeyEventHandler((e) => {
      // 한글 조합 중에는 아무것도 가로채지 않는다.
      if (e.isComposing || e.keyCode === 229) return true;

      const action = terminalKeyAction(e);
      if (action) {
        const rawCtrlV = action === 'paste' && !e.shiftKey && e.key.toLowerCase() === 'v';
        const passThrough =
          // vim·less·tmux 같은 대체 화면에서는 Ctrl+V 가 그 프로그램의 것이다.
          (rawCtrlV && term.buffer.active.type === 'alternate') ||
          // 선택이 없으면 Ctrl+C 는 예전처럼 셸로 가 실행 중인 명령을 끊는다.
          (action === 'copy-if-selection' && term.getSelection().trim() === '');
        if (!passThrough) {
          // xterm 의 ^C/^V 전송과 웹뷰 기본 붙여넣기(중복!)를 함께 막는다.
          e.preventDefault();
          e.stopPropagation();
          if (action === 'paste') {
            // xterm 은 이 처리기가 false 를 돌려주면 자기 scrollOnUserInput 을 건너뛴다 —
            // 스크롤을 올려 둔 채 claude·codex 에 붙여넣으면 방금 넣은 게 화면 밖에 남는다.
            term.scrollToBottom();
            pasteClipboard();
          } else if (action === 'newline') {
            // 순수 LF — 이미 아무 데서나 그냥 통과하는 Ctrl+J 와 같은 바이트라 vim 등에서도 무해하다.
            term.scrollToBottom();
            void writePty(pane.id, '\n').catch(() => {});
          } else {
            void copySelection();
          }
          return false;
        }
      }
      return !appOwnsKey(e);
    });

    // 키 입력 → PTY. (ConPTY 의 커서 위치 질의도 xterm 이 여기로 답한다.)
    const dataSub = term.onData((d) => void writePty(pane.id, d).catch(() => {}));
    const binarySub = term.onBinary((d) => void writePty(pane.id, d).catch(() => {}));

    // PTY → 화면. rAF 로 모아 써서 대량 출력에도 프레임을 지킨다.
    const queue: Uint8Array[] = [];
    let frame = 0;
    let restoreDone = false;

    const flushQueue = () => {
      frame = 0;
      if (disposed || !restoreDone) return;
      while (queue.length) {
        term.write(queue.shift()!);
      }
    };
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(flushQueue);
    };

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      queue.push(new Uint8Array(buf));
      schedule();
    };

    void openPty(sessionId, pane.id, term.cols, term.rows, channel)
      .then((res) => {
        if (disposed) return;
        // 이전 화면을 먼저 되살리고, 배너로 과거와 현재를 가른다.
        if (res.restored) term.write(res.restored);
        if (res.banner) term.write(res.banner);
        restoreDone = true;
        schedule();
        void refresh();
      })
      .catch((e: unknown) => {
        if (disposed) return;
        const msg = typeof e === 'string' ? e : '셸을 시작할 수 없습니다';
        term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
        restoreDone = true;
      });

    // 패널 크기가 바뀌면 ConPTY 에도 알려야 프롬프트 폭이 따라온다.
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        void resizePty(pane.id, term.cols, term.rows).catch(() => {});
      });
    });
    observer.observe(host);

    // 셸이 끝나면 화면에 남겨 알린다 (창은 그대로 두어 스크롤백을 읽을 수 있게).
    const exitPromise = listen<PtyExitEvent>('pty://exit', (event) => {
      if (disposed || event.payload.paneId !== pane.id) return;
      term.write(`\r\n\x1b[90m[프로세스 종료 · 코드 ${event.payload.code}]\x1b[0m\r\n`);
      void refresh();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      unregisterClipboard();
      void exitPromise.then((un) => un());
      // 세션을 옮기는 것뿐일 수 있으므로 셸은 죽이지 않고 채널만 뗀다.
      void detachPty(pane.id).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, sessionId]);

  // 확대 배율은 별도로 따라간다 — 터미널을 다시 만들지 않는다.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    if (term.options.fontSize === pane.zoom) return;
    term.options.fontSize = pane.zoom;
    try {
      fit.fit();
    } catch {
      return;
    }
    void resizePty(pane.id, term.cols, term.rows).catch(() => {});
  }, [pane.zoom, pane.id]);

  return (
    <div
      className="term-body"
      ref={hostRef}
      onMouseDown={(e) => {
        // 편집 모드의 드래그를 방해하지 않도록 선택 조작만 흘려보낸다.
        if (useStore.getState().editMode) {
          e.preventDefault();
          return;
        }
        // 가운데 버튼 = 붙여넣기. 마우스를 쓰는 앱(vim·tmux)이 이미 가져갔으면 넘긴다.
        if (e.button === 1 && !e.defaultPrevented) {
          e.preventDefault();
          termRef.current?.scrollToBottom();
          terminalClipboard(pane.id)?.paste();
        }
      }}
    />
  );
}
