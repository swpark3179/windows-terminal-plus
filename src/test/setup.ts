import '@testing-library/jest-dom/vitest';

// jsdom 에는 없지만 터미널 패널이 쓰는 것들.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;

// 클립보드 플러그인은 최상위에서 `@tauri-apps/api/image` 를 끌어오고, 그것이 다시
// `@tauri-apps/api/core` 의 `Resource` 를 상속한다. 개별 테스트가 core 를 `{ invoke, Channel }`
// 로만 모킹하므로 그대로 두면 `bridge.ts` 를 import 하는 순간 "Class extends value undefined"
// 로 죽는다. 그래서 플러그인 자체를 여기서 한 번 가짜로 바꾼다.
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
  writeText: vi.fn(async () => {}),
}));

if (!('clipboard' in navigator)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
    configurable: true,
  });
}
