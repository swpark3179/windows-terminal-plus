/**
 * 창 id → 그 창의 복사·붙여넣기 손잡이.
 *
 * 우클릭 메뉴와 가운데 클릭 처리기는 xterm 을 만든 effect 클로저 밖에 있다.
 * `Terminal` 인스턴스는 직렬화가 안 되고 넣는 순간 리렌더를 부르므로 zustand 에 둘 수 없다 —
 * 그래서 이 얇은 맵 하나로 잇는다.
 */

export interface TerminalClipboard {
  copy: () => Promise<void>;
  paste: () => void;
}

const handles = new Map<string, TerminalClipboard>();

/** 등록하고 해제 함수를 돌려준다. */
export function registerTerminalClipboard(paneId: string, api: TerminalClipboard): () => void {
  handles.set(paneId, api);
  return () => {
    // StrictMode 의 이중 마운트나 세션 전환에서 **새로 등록된** 손잡이를 지우면 안 된다.
    if (handles.get(paneId) === api) handles.delete(paneId);
  };
}

export function terminalClipboard(paneId: string): TerminalClipboard | undefined {
  return handles.get(paneId);
}
