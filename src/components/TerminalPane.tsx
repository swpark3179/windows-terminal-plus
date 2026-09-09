import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Base64, ClipboardAddon, type ClipboardSelectionType } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import {
  Channel,
  detachPty,
  openExternalUrl,
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
import { createTermLinks } from '../lib/termLinks';
import { sanitizeTerminalText } from '../lib/termText';
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

/** 벨을 화면으로 알리는 시간(ms). 소리는 내지 않는다 — 창이 여럿인 앱에서 어느 창인지 알 수 없다. */
const BELL_FLASH_MS = 140;

export function TerminalPane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** 벨을 알릴 곳 — 창의 눈에 보이는 테두리는 `.term-body` 다. */
  const bodyRef = useRef<HTMLDivElement>(null);
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

    // 하이퍼링크. `term` 이 아직 없으므로 칩을 붙일 곳은 나중에 읽는다 (마우스를 올릴 때 불린다).
    let live: Terminal | null = null;
    const links = createTermLinks({
      element: () => live?.element,
      flash,
      open: openExternalUrl,
    });

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
      // 주지 않으면 xterm 이 자기 기본 동작(영어 confirm + `location.href`)으로 물러난다 —
      // 창이 하나뿐인 이 앱에서는 문서째로 옮겨 가 모든 터미널이 사라진다 (`lib/termLinks.ts`).
      linkHandler: links.handler,
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

    live = term;
    term.open(host);
    try {
      const webgl = new WebglAddon();
      // 절전에서 깨거나 드라이버가 갱신되면 GPU 컨텍스트가 날아간다. 그대로 두면 셸은 계속
      // 도는데 화면만 옛 글자로 얼어붙는다. xterm 이 안내하는 처리는 애드온을 떼는 것뿐 —
      // 그러면 DOM 렌더러로 돌아가 다시 그려진다.
      webgl.onContextLoss(() => {
        webgl.dispose();
        flash('그래픽 컨텍스트를 잃어 기본 렌더러로 돌아갔습니다');
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL 이 아예 없으면 기본 DOM 렌더러로 조용히 물러난다.
    }

    // 평범한 글자 속 주소도 윈도우 터미널처럼 누를 수 있게 한다 (OSC 8 은 xterm 이 이미 안다).
    // 찾는 규칙은 애드온 기본값을 그대로 쓴다 — http·https 만 잡고 문장 끝 구두점을 떼 준다
    // (`WebLinksAddon.ts` 의 `strictUrlRegex`). 우리가 다시 쓰면 localhost 같은 것을 놓친다.
    term.loadAddon(
      new WebLinksAddon(links.activate, { hover: links.hover, leave: links.leave }),
    );
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
          } else if (action === 'select-all') {
            term.selectAll();
          } else if (action === 'clear') {
            // 윈도우 터미널의 "버퍼 지우기" — 보이는 화면은 남기고 스크롤백만 버린다.
            term.clear();
            flash('스크롤백을 비웠습니다');
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

    // 셸이 OSC 0/2 로 알려 주는 제목을 창 머리글에 그대로 싣는다 — 지금 무엇이 도는지가 보인다.
    // 값은 프로그램이 정하므로 반드시 다듬어 넣는다 (`lib/termText.ts`).
    const titleSub = term.onTitleChange((raw) => {
      if (disposed) return;
      const clean = sanitizeTerminalText(raw);
      if (clean) useStore.getState().setLiveTitle(pane.id, clean);
    });

    // 벨. xterm 5.5 에는 벨 표시가 아예 없어 지금까지 완전히 조용했다 (탭 완성 모호, 검색 실패…).
    let bellTimer: ReturnType<typeof setTimeout> | undefined;
    const bellSub = term.onBell(() => {
      const body = bodyRef.current;
      if (disposed || !body) return;
      body.classList.add('term-body--bell');
      clearTimeout(bellTimer);
      // 벨이 연달아 오면 깜빡이지 않고 켜진 상태를 늘린다.
      bellTimer = setTimeout(() => body.classList.remove('term-body--bell'), BELL_FLASH_MS);
    });

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
      titleSub.dispose();
      bellSub.dispose();
      clearTimeout(bellTimer);
      bodyRef.current?.classList.remove('term-body--bell');
      links.dispose();
      modeHandlers.forEach((h) => h.dispose());
      unregisterClipboard();
      void exitPromise.then((un) => un());
      // 세션을 옮기는 것뿐일 수 있으므로 셸은 죽이지 않고 채널만 뗀다.
      void detachPty(pane.id).catch(() => {});
      term.dispose();
      live = null;
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
      ref={bodyRef}
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
