/** 이미지 뷰어의 순수 계산 — 배율 단계와 색 표기. */

/** 뷰어가 오가는 배율 단계(%). */
export const ZOOM_STEPS = [10, 25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1600];

/** 스포이드가 보여 주는 표기 — 요청대로 `0x00ff00` 꼴. */
export function toHex(r: number, g: number, b: number): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `0x${byte(r)}${byte(g)}${byte(b)}`;
}

/** 다음(1) 또는 이전(-1) 배율 단계. 끝에서는 더 나아가지 않는다. */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current) ?? ZOOM_STEPS[0];
}

/** 원본이 창보다 크면 줄이고, 작으면 원본 크기 그대로 둔다. */
export function fitScale(
  box: { width: number; height: number },
  image: { width: number; height: number },
  padding = 24,
): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  const w = Math.max(box.width - padding, 1);
  const h = Math.max(box.height - padding, 1);
  return Math.min(1, w / image.width, h / image.height);
}

/** 화면 좌표를 원본 픽셀 좌표로 되돌린다. 이미지 밖이면 `null`. */
export function toImagePixel(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.floor(((point.x - rect.left) / rect.width) * natural.width);
  const y = Math.floor(((point.y - rect.top) / rect.height) * natural.height);
  if (x < 0 || y < 0 || x >= natural.width || y >= natural.height) return null;
  return { x, y };
}
