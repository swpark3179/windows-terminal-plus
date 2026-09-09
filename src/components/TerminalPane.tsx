import { useEffect, useRef, useState } from 'react';
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
import { TERM_THEME, WORD_SEPARATOR } from '../lib/termTheme';
import { registerTerminalClipboard, terminalClipboard } from '../lib/terminalRegistry';
import { WIN32_INPUT_MODE, newlineSequence, setWin32InputMode } from '../lib/win32Input';
import { useStore } from '../state/store';
import type { Pane, PtyExitEvent } from '../state/types';
import { TerminalScrollbar } from './TerminalScrollbar';

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
  // 스크롤 막대에 넘겨줄 인스턴스. ref 로는 막대가 붙을 때를 알 수 없어 상태로도 들고 있는다.
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const refresh = useStore((s) => s.refresh);

  // 터미널 수명은 패널 id 에 묶인다. 스냅샷이 갱신돼도 다시 만들지 않는다.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const flash = (msg: string) => useStore.getState().flash(msg);

    const term = new Terminal({
      allowProposedApi: true,
      // Cascadia Mono → (없으면) 함께 담은 Noto Sans Mono → 한글은 Noto Sans KR.
      // 앞의 두 글꼴에는 한글 글리프가 **하나도 없어서** 마지막 항목이 반드시 있어야 한다.
      fontFamily: "'Cascadia Mono', 'Noto Sans Mono', 'Noto Sans KR', monospace",
      fontSize: pane.zoom,
      // 1.0 이 윈도우 터미널의 칸 비율에 가깝지만, 한글을 그리는 Noto Sans KR 의 글자 상자가
      // 1.45em 이라 칸 높이가 그보다 낮으면 위아래가 잘린다. 1.25 가 잘리지 않는 가장 좁은 값이다.
      lineHeight: 1.25,
      // 0 이 기본값이지만 명시해 둔다 — WebGL 렌더러는 칸 너비를 내림한 **뒤에** 이 값을 더해서,
      // 0 이 아니면 글자가 칸에서 조금씩 밀려난다.
      letterSpacing: 0,
      fontWeight: 400,
      // 이제 진짜 700 얼굴이 담겨 있다 (`app.css` 의 cascadia-mono/700).
      fontWeightBold: 700,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8192,
      theme: TERM_THEME,
      wordSeparator: WORD_SEPARATOR,
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

    // ConPTY 는 부팅하며 `CSI ? 9001 h` 로 win32-input-mode 를 청한다 (`lib/win32Input.ts`).
    // xterm 은 모르는 사설 모드라 조용히 버리므로 여기서 가로채 기억해 둔다.
    // **우리 것이 아니면 반드시 false 를 돌려준다** — 이 자리는 대체 화면·괄호 붙여넣기·마우스
    // 보고가 모두 지나가는 길목이라, true 를 잘못 돌려주면 xterm 의 기본 처리가 통째로 사라진다.
    const win32Mode = (on: boolean) => (params: (number | number[])[]) => {
      if (params.length !== 1 || params[0] !== WIN32_INPUT_MODE) return false;
      setWin32InputMode(pane.id, on);
      return true;
    };
    const modeHandlers = [
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, win32Mode(true)),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, win32Mode(false)),
    ];

    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL 이 없으면 기본 DOM 렌더러로 조용히 물러난다.
    }
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;
    setTerminal(term);

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
      const action = terminalKeyAction(e);
      // 한글 조합 중에는 클립보드 조합 말고 아무것도 가로채지 않는다. 조합 중인 음절은 아직 PTY 로
      // 가지 않았을 수 있어, 다른 키를 앞질러 보내면 입력 순서가 뒤집힌다. 복사·붙여넣기는 조합에
      // 섞이는 조합이 아니고, 클립보드 읽기가 비동기라 사실상 조합이 먼저 끝난다.
      const clipboard = action === 'copy' || action === 'paste' || action === 'copy-if-selection';
      if (!clipboard && (e.isComposing || e.keyCode === 229)) return true;

      if (action) {
        // 선택이 없으면 Ctrl+C 는 예전처럼 셸로 가 실행 중인 명령을 끊는다.
        // (Ctrl+V 는 대체 화면에서도 붙여넣기다 — claude·codex 가 거기서 돌기 때문이다.
        //  vim 의 비주얼 블록은 vim 이 안내하는 대로 Ctrl+Q 를 쓴다.)
        const passThrough = action === 'copy-if-selection' && term.getSelection().trim() === '';
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
            // ConPTY 가 win32-input-mode 를 청했으면 진짜 Shift+Enter 키 이벤트로, 아니면 예전처럼
            // 순수 LF 로 보낸다. 어느 쪽이든 바이트로 펴지는 곳에는 LF 가 닿는다 (`lib/win32Input.ts`).
            term.scrollToBottom();
            void writePty(pane.id, newlineSequence(pane.id)).catch(() => {});
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
      modeHandlers.forEach((h) => h.dispose());
      unregisterClipboard();
      void exitPromise.then((un) => un());
      // 세션을 옮기는 것뿐일 수 있으므로 셸은 죽이지 않고 채널만 뗀다.
      void detachPty(pane.id).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setTerminal(null);
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
    >
      {/*
        xterm 이 자기 DOM 을 붙일 노드에는 리액트 자식을 두지 않는다 — 한 노드를 둘이 만지면
        서로의 자식을 지운다. 그래서 호스트를 안쪽으로 한 겹 내리고 막대는 형제로 둔다.
        (FitAddon 은 `.xterm` 의 부모를 재므로 이제 `.term-host` 를 본다.)
      */}
      <div className="term-host" ref={hostRef} />
      {terminal && <TerminalScrollbar term={terminal} ai={pane.ai} />}
    </div>
  );
}
