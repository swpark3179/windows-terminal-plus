/**
 * 나눈 자리가 물려받을 폴더의 판정.
 *
 * "곧바로 열면 물려받고, 그 사이 다른 일이 있었으면 물려받지 않는다" 가 규칙이다.
 * 여기서는 판정만 본다 — 스냅샷이 갈릴 때 기억이 지워지는 배선은 `App.test.tsx` 가,
 * 셸이 그새 폴더를 옮겼는지의 마지막 확인은 Rust 가 맡는다.
 */

import { describe, expect, it } from 'vitest';

import { inheritForPane, inheritFromSplit, type PendingCwd } from './paneCwd';
import type { Pane } from '../state/types';

const CWD = 'C:/work/rterm/src';

function pane(id: string, over: Partial<Pane> = {}): Pane {
  return {
    id,
    kind: 'empty',
    title: '빈 블럭',
    r: 1,
    c: 1,
    rs: 1,
    cs: 1,
    zoom: 14,
    alive: false,
    dirty: false,
    ...over,
  };
}

const term = (over: Partial<Pane> = {}) =>
  pane('p-term', { kind: 'term', alive: true, cwd: CWD, ...over });
const fresh = () => pane('p-new');

const remembered: PendingCwd = { paneId: 'p-new', sourceId: 'p-term', cwd: CWD };

describe('분할 직후 기억해 둘 폴더', () => {
  it('폴더를 알려 준 터미널을 나눴으면 그 폴더를 기억한다', () => {
    expect(inheritFromSplit([term(), fresh()], 'p-term', 'p-new')).toEqual(remembered);
  });

  it('폴더를 모르는 터미널에서는 물려줄 것이 없다', () => {
    // 셸 통합이 없거나 아직 첫 프롬프트 전 — 지어내지 않는다.
    expect(inheritFromSplit([term({ cwd: null }), fresh()], 'p-term', 'p-new')).toBeNull();
    expect(inheritFromSplit([term({ cwd: '   ' }), fresh()], 'p-term', 'p-new')).toBeNull();
  });

  it('터미널이 아닌 창이나 끝난 셸에서는 물려주지 않는다', () => {
    const md = pane('p-term', { kind: 'md', cwd: CWD });
    expect(inheritFromSplit([md, fresh()], 'p-term', 'p-new')).toBeNull();
    expect(inheritFromSplit([term({ alive: false }), fresh()], 'p-term', 'p-new')).toBeNull();
  });
});

describe('그 블럭에 터미널을 열 때', () => {
  it('기억한 그대로면 물려받는다', () => {
    expect(inheritForPane([term(), fresh()], remembered, 'p-new')).toEqual(remembered);
  });

  it('기억해 둔 블럭이 아니면 물려받지 않는다', () => {
    expect(inheritForPane([term(), fresh(), pane('p-other')], remembered, 'p-other')).toBeNull();
    expect(inheritForPane([term(), fresh()], null, 'p-new')).toBeNull();
  });

  it('그 사이 그 블럭에 무엇인가 열렸으면 물려받지 않는다', () => {
    const taken = pane('p-new', { kind: 'text', title: 'notes.txt' });
    expect(inheritForPane([term(), taken], remembered, 'p-new')).toBeNull();
  });

  it('나눠 준 터미널이 폴더를 옮겼으면 세션 폴더로 돌아간다', () => {
    const moved = term({ cwd: 'C:/work/other' });
    expect(inheritForPane([moved, fresh()], remembered, 'p-new')).toBeNull();
  });

  it('나눠 준 터미널이 사라졌거나 끝났으면 물려받지 않는다', () => {
    expect(inheritForPane([fresh()], remembered, 'p-new')).toBeNull();
    expect(inheritForPane([term({ alive: false }), fresh()], remembered, 'p-new')).toBeNull();
  });
});
