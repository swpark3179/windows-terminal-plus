import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { Channel, detachPty, openPty, resizePty, writePty } from '../ipc/bridge';
import { appOwnsKey } from '../lib/keys';
import { useStore } from '../state/store';
import type { Pane, PtyExitEvent } from '../state/types';

/** 디자인 터미널 색상. */
const THEME = {
  background: '#1b1a18',
  foreground: '#eceae4',
  cursor: '#d99b74',
  cursorAccent: '#1b1a18',
  selectionBackground: '#413b33',
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

export function TerminalPane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const refresh = useStore((s) => s.refresh);

  // 터미널 수명은 패널 id 에 묶인다. 스냅샷이 갱신돼도 다시 만들지 않는다.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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

    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL 이 없으면 기본 DOM 렌더러로 조용히 물러난다.
    }
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((e) => !appOwnsKey(e));

    // 키 입력 → PTY. (ConPTY 의 커서 위치 질의도 xterm 이 여기로 답한다.)
    const dataSub = term.onData((d) => void writePty(pane.id, d).catch(() => {}));
    const binarySub = term.onBinary((d) => void writePty(pane.id, d).catch(() => {}));

    // PTY → 화면. rAF 로 모아 써서 대량 출력에도 프레임을 지킨다.
    const queue: Uint8Array[] = [];
    let frame = 0;
    let restoreDone = false;
    let disposed = false;

    const flush = () => {
      frame = 0;
      if (disposed || !restoreDone) return;
      while (queue.length) {
        term.write(queue.shift()!);
      }
    };
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(flush);
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
        if (useStore.getState().editMode) e.preventDefault();
      }}
    />
  );
}
