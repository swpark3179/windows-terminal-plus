/**
 * 터미널 안의 하이퍼링크.
 *
 * ## 왜 손으로 배선해야 하는가
 *
 * xterm 은 OSC 8 하이퍼링크를 **이미** 알아듣고 클릭할 수 있게 만들어 둔다. `linkHandler` 를
 * 주지 않으면 자기 기본 동작(`browser/OscLinkProvider.ts` 의 `defaultActivate`)으로 물러나는데,
 * 그것으로는 셋이 어긋난다.
 *
 * 1. **영어 `confirm()`** 한 번을 띄운다 — 한국어 UI 에 번역되지 않은 브라우저 대화상자다.
 * 2. **수정자를 요구하지 않는다** — 화면에 찍힌 주소를 지나가다 한 번 누르면 그대로 열린다.
 *    주소를 정하는 것은 화면 속 프로그램이므로(`cat evil.bin`) 그래서는 안 된다.
 * 3. `window.open()` 뒤 그 창의 `location.href` 를 쓴다. Tauri 웹뷰(WebView2)에서 그것이 무엇을
 *    여는지는 앱이 정하지 않는다 — 막히거나, 앱이 다루지 않는 팝업 웹뷰가 뜬다. 터미널이 여는
 *    주소는 OS 기본 브라우저로 가야 하고, 그 길에는 우리 검사(`commands/link.rs`)가 있어야 한다.
 *
 * ## 안전 규칙
 *
 * 주소를 정하는 것은 터미널 안에서 도는 프로그램이고, OSC 8 은 **보이는 글자와 실제 주소를
 * 따로 싣는다**. `\x1b]8;;https://evil.tld\x1b\\https://github.com\x1b]8;;\x1b\\` 는 화면에
 * github 주소로 보이면서 evil.tld 로 간다. 스킴 검사로는 이것을 못 잡는다. 그래서
 *
 * 1. **Ctrl+클릭** 만 연다 — 지나가는 클릭으로 브라우저가 뜨지 않는다 (윈도우 터미널과 같은 규칙).
 * 2. 마우스를 올리면 **실제 주소**를 칩으로 띄운다 — 눈속임을 눈으로 확인할 수 있게.
 * 3. 실제 열기는 Rust 가 스킴까지 확인한 뒤에 한다 (`commands/link.rs`).
 */

import type { ILinkHandler } from '@xterm/xterm';

import { sanitizeTerminalText } from './termText';

/** 칩이 커서를 가리지 않도록 위로 띄우는 거리(px). */
const CHIP_LIFT = 22;

export interface TermLinks {
  /** xterm 옵션의 `linkHandler` — OSC 8 하이퍼링크용. */
  handler: ILinkHandler;
  /** `WebLinksAddon` 에 넘길 것들 — 평범한 글자 속 주소를 찾아 주는 쪽. */
  activate: (event: MouseEvent | undefined, uri: string) => void;
  hover: (event: MouseEvent, uri: string) => void;
  leave: () => void;
  dispose: () => void;
}

export function createTermLinks(deps: {
  /** 칩을 붙일 곳. 터미널이 아직 열리지 않았으면 `undefined`. */
  element: () => HTMLElement | undefined | null;
  flash: (message: string) => void;
  /** 실제 열기. 실패하면 reject. */
  open: (url: string) => Promise<void>;
}): TermLinks {
  let chip: HTMLDivElement | null = null;

  const hideChip = () => {
    chip?.remove();
    chip = null;
  };

  const showChip = (event: MouseEvent, uri: string) => {
    const host = deps.element();
    if (!host) return;
    if (!chip) {
      chip = document.createElement('div');
      // `xterm-hover` 는 xterm 이 "이건 링크 위에 뜬 것" 으로 아는 표시다.
      chip.className = 'xterm-hover term-link-chip';
      host.appendChild(chip);
    }
    chip.textContent = sanitizeTerminalText(uri);

    // 터미널 안에 머무르도록 가둔다 — 오른쪽·위쪽 끝에서 잘리지 않게.
    const box = host.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - box.left, box.width - chip.offsetWidth));
    const y = Math.max(0, event.clientY - box.top - CHIP_LIFT);
    chip.style.left = `${Math.round(x)}px`;
    chip.style.top = `${Math.round(y)}px`;
  };

  const activate = (event: MouseEvent | undefined, uri: string) => {
    // 주 버튼이 아니면 링크 클릭이 아니다. 우클릭(창 메뉴)·가운데 클릭(붙여넣기)에도 이 처리기가
    // 불리므로, 걸러 내지 않으면 그 두 조작마다 엉뚱한 안내가 뜬다.
    if (!event || event.button !== 0) return;
    // Ctrl 없이 눌렀다면 열지 않는다. 이 주소는 화면에 찍힌 것이므로 사용자가 의도한 클릭이라는
    // 보장이 없다 — 마침 그 자리를 눌렀을 수도 있다.
    if (!event.ctrlKey) {
      deps.flash('Ctrl + 클릭으로 브라우저에서 엽니다');
      return;
    }
    // ASCII 로 정규화해서 넘긴다. xterm 은 `new URL()` 로만 걸러서 한글 경로·IDN 호스트가 든
    // 주소도 링크로 내주는데, Rust 검사는 ASCII 만 받는다 — 여기서 퍼센트 인코딩·퓨니코드로
    // 바꿔 두지 않으면 눌러도 오류 토스트만 뜬다.
    let normalized: string;
    try {
      normalized = new URL(uri).href;
    } catch {
      deps.flash('주소를 읽을 수 없습니다');
      return;
    }
    hideChip();
    deps.open(normalized).catch((e: unknown) => {
      deps.flash(typeof e === 'string' ? e : '주소를 열 수 없습니다');
    });
  };

  const hover = (event: MouseEvent, uri: string) => showChip(event, uri);

  return {
    handler: {
      activate,
      hover,
      leave: hideChip,
      // 지정하지 않으면 xterm 이 http·https 가 아닌 주소를 아예 넘기지 않는다. 그대로 둔다.
    },
    activate,
    hover,
    leave: hideChip,
    dispose: hideChip,
  };
}
