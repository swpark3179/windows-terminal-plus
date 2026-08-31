import { describe, expect, it } from 'vitest';
import { fitScale, stepZoom, toHex, toImagePixel, ZOOM_STEPS } from './imageView';

describe('toHex', () => {
  it('요청한 0x00ff00 꼴로 만든다', () => {
    expect(toHex(0, 255, 0)).toBe('0x00ff00');
    expect(toHex(201, 100, 66)).toBe('0xc96442');
    expect(toHex(0, 0, 0)).toBe('0x000000');
    expect(toHex(255, 255, 255)).toBe('0xffffff');
  });

  it('한 자리 값도 0 을 채운다', () => {
    expect(toHex(1, 2, 3)).toBe('0x010203');
  });

  it('범위를 벗어난 값은 잘라 낸다', () => {
    expect(toHex(-5, 300, 128.6)).toBe('0x00ff81');
  });
});

describe('stepZoom', () => {
  it('다음 단계로 올라간다', () => {
    expect(stepZoom(100, 1)).toBe(150);
    expect(stepZoom(10, 1)).toBe(25);
  });

  it('이전 단계로 내려간다', () => {
    expect(stepZoom(100, -1)).toBe(75);
    expect(stepZoom(1600, -1)).toBe(800);
  });

  it('단계 사이 값에서도 올바른 이웃을 찾는다', () => {
    expect(stepZoom(120, 1)).toBe(150);
    expect(stepZoom(120, -1)).toBe(100);
  });

  it('끝에서는 더 나아가지 않는다', () => {
    expect(stepZoom(1600, 1)).toBe(1600);
    expect(stepZoom(10, -1)).toBe(10);
    expect(stepZoom(5, -1)).toBe(ZOOM_STEPS[0]);
  });
});

describe('fitScale', () => {
  it('원본이 크면 창에 맞춰 줄인다', () => {
    // 여백 24 를 뺀 376 / 1000
    expect(fitScale({ width: 400, height: 4000 }, { width: 1000, height: 1000 })).toBeCloseTo(0.376);
  });

  it('원본이 작으면 확대하지 않는다', () => {
    expect(fitScale({ width: 800, height: 800 }, { width: 40, height: 40 })).toBe(1);
  });

  it('가로·세로 중 더 빡빡한 쪽을 따른다', () => {
    const scale = fitScale({ width: 1024, height: 224 }, { width: 500, height: 500 });
    expect(scale).toBeCloseTo(0.4); // (224-24)/500
  });

  it('크기가 0 이어도 무너지지 않는다', () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('toImagePixel', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  const natural = { width: 400, height: 200 };

  it('화면 좌표를 원본 픽셀로 되돌린다 (2배로 그려진 경우)', () => {
    expect(toImagePixel({ x: 100, y: 50 }, rect, natural)).toEqual({ x: 0, y: 0 });
    expect(toImagePixel({ x: 200, y: 100 }, rect, natural)).toEqual({ x: 200, y: 100 });
  });

  it('이미지 밖이면 null', () => {
    expect(toImagePixel({ x: 99, y: 60 }, rect, natural)).toBeNull();
    expect(toImagePixel({ x: 150, y: 49 }, rect, natural)).toBeNull();
    expect(toImagePixel({ x: 300, y: 60 }, rect, natural)).toBeNull();
    expect(toImagePixel({ x: 150, y: 150 }, rect, natural)).toBeNull();
  });

  it('크기가 0 인 상자는 null', () => {
    expect(toImagePixel({ x: 0, y: 0 }, { ...rect, width: 0 }, natural)).toBeNull();
  });
});
