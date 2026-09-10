import { describe, expect, it } from 'vitest';
import { activeHeading, readOutline } from './mdOutline';
import { MD_PREFS_DEFAULT, docStats, fontStack, normalisePrefs } from './mdView';
import { nameProblem, previewName } from './newFile';

describe('뷰어 설정', () => {
  it('저장소에 없거나 모르는 값은 기본값으로 채운다', () => {
    expect(normalisePrefs(null)).toEqual(MD_PREFS_DEFAULT);
    expect(normalisePrefs('망가진 값')).toEqual(MD_PREFS_DEFAULT);
    expect(normalisePrefs({ theme: 'neon', font: 'comic' })).toEqual(MD_PREFS_DEFAULT);
  });

  it('아는 값만 골라 받는다', () => {
    expect(normalisePrefs({ theme: 'dark', font: 'serif', toc: true, narrow: false })).toEqual({
      theme: 'dark',
      font: 'serif',
      toc: true,
      narrow: false,
    });
    // 일부만 저장돼 있어도 나머지는 기본값이다.
    expect(normalisePrefs({ theme: 'dark' }).font).toBe(MD_PREFS_DEFAULT.font);
  });

  it('글꼴 이름을 실제 스택으로 바꾼다', () => {
    expect(fontStack('mono')).toContain('Cascadia Mono');
    expect(fontStack('serif')).toContain('Georgia');
  });
});

describe('docStats', () => {
  it('줄·낱말·글자 수를 센다', () => {
    expect(docStats('가 나\n다')).toBe('2줄 · 3단어 · 5자');
  });

  it('빈 문서도 셀 수 있다', () => {
    expect(docStats('')).toBe('0줄 · 0단어 · 0자');
  });
});

describe('목차', () => {
  it('그려진 제목에서 목차를 만든다', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<h1 data-md-heading="0" data-md-level="1">하나</h1>' +
      '<p>본문</p>' +
      '<h2 data-md-heading="1" data-md-level="2">둘</h2>';
    expect(readOutline(root)).toEqual([
      { index: 0, level: 1, text: '하나' },
      { index: 1, level: 2, text: '둘' },
    ]);
  });

  it('제목이 없으면 빈 목차다', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>제목 없는 글</p>';
    expect(readOutline(root)).toEqual([]);
  });

  it('화면 위쪽 경계를 지난 마지막 제목이 켜진다', () => {
    const offsets = [0, 120, 400];
    expect(activeHeading(offsets, 0)).toBe(0);
    expect(activeHeading(offsets, 110)).toBe(0);
    expect(activeHeading(offsets, 120)).toBe(1);
    expect(activeHeading(offsets, 900)).toBe(2);
  });

  it('첫 제목보다 위에 있으면 켜진 것이 없다', () => {
    expect(activeHeading([50, 200], 0)).toBe(-1);
    expect(activeHeading([], 0)).toBe(-1);
  });

  it('제목을 눌러 이동한 자리에서 그 제목이 곧바로 켜진다', () => {
    // `scrollTo` 는 제목보다 8px 위에 놓는다 — 여유가 없으면 앞 제목이 켜진 채로 남는다.
    expect(activeHeading([0, 120], 120 - 4)).toBe(1);
  });
});

describe('새 파일 이름', () => {
  it('확장자를 적지 않으면 고른 종류를 붙여 보여 준다', () => {
    expect(previewName('메모', 'md')).toBe('메모.md');
    expect(previewName('메모', 'txt')).toBe('메모.txt');
    expect(previewName('docs/메모', 'md')).toBe('docs/메모.md');
  });

  it('이미 확장자가 있으면 그대로 둔다', () => {
    expect(previewName('readme.markdown', 'md')).toBe('readme.markdown');
    expect(previewName('notes.txt', 'md')).toBe('notes.txt');
  });

  it('아직 아무것도 안 적었으면 미리보기도 없다', () => {
    expect(previewName('  ', 'md')).toBe('');
  });

  it('만들 수 없는 이름을 미리 알려 준다', () => {
    expect(nameProblem('a?b')).toMatch(/쓸 수 없습니다/);
    expect(nameProblem('../secret.md')).toMatch(/밖으로는/);
    expect(nameProblem('/etc/passwd')).toMatch(/아래의 이름만/);
    expect(nameProblem('메모.')).toMatch(/점이나 공백/);
  });

  it('멀쩡한 이름은 나무라지 않는다', () => {
    expect(nameProblem('메모')).toBeNull();
    expect(nameProblem('docs/설계 노트.md')).toBeNull();
    // 빈 칸은 아직 안 적었을 뿐이다.
    expect(nameProblem('')).toBeNull();
  });
});
