import { describe, expect, it } from 'vitest';
import { classifyHref, resolveDocPath } from './mdLinks';

describe('classifyHref', () => {
  it('웹 주소와 메일은 바깥으로 보낸다', () => {
    expect(classifyHref('https://example.com')).toBe('ext');
    expect(classifyHref('HTTP://example.com')).toBe('ext');
    expect(classifyHref('mailto:a@b.com')).toBe('ext');
  });

  it('`#` 은 같은 문서 안이다', () => {
    expect(classifyHref('#설계-노트')).toBe('anchor');
  });

  it('스킴이 없으면 옆 파일이다', () => {
    expect(classifyHref('./guide.md')).toBe('rel');
    expect(classifyHref('docs/api.md')).toBe('rel');
    expect(classifyHref('..\\README.md')).toBe('rel');
  });

  it('다룰 수 없는 스킴은 아예 막는다', () => {
    expect(classifyHref('javascript:alert(1)')).toBe('blocked');
    expect(classifyHref('JavaScript:alert(1)')).toBe('blocked');
    expect(classifyHref('data:text/html,<script>')).toBe('blocked');
    expect(classifyHref('vbscript:msgbox')).toBe('blocked');
    expect(classifyHref('file:///C:/Windows')).toBe('blocked');
    expect(classifyHref('')).toBe('blocked');
  });
});

describe('resolveDocPath', () => {
  it('문서가 쓰던 구분자를 그대로 쓴다', () => {
    expect(resolveDocPath('C:\\work\\docs\\a.md', 'b.md')).toBe('C:\\work\\docs\\b.md');
    expect(resolveDocPath('/work/docs/a.md', 'b.md')).toBe('/work/docs/b.md');
  });

  it('`./` 와 하위 폴더를 푼다', () => {
    expect(resolveDocPath('/work/a.md', './docs/b.md')).toBe('/work/docs/b.md');
    expect(resolveDocPath('C:\\work\\a.md', 'docs/b.md')).toBe('C:\\work\\docs\\b.md');
  });

  it('`..` 로 위 폴더도 간다', () => {
    expect(resolveDocPath('/work/docs/a.md', '../README.md')).toBe('/work/README.md');
    expect(resolveDocPath('C:\\work\\docs\\a.md', '..\\README.md')).toBe('C:\\work\\README.md');
  });

  it('뿌리 위로는 올라가지 않는다', () => {
    expect(resolveDocPath('/work/a.md', '../../../../etc/passwd')).toBe('/etc/passwd');
  });

  it('앵커와 물음표는 떼고 본다', () => {
    expect(resolveDocPath('/work/a.md', 'b.md#제목')).toBe('/work/b.md');
    expect(resolveDocPath('/work/a.md', 'b.md?v=1')).toBe('/work/b.md');
  });

  it('주소에 인코딩된 공백을 되돌린다', () => {
    expect(resolveDocPath('/work/a.md', '설계%20노트.md')).toBe('/work/설계 노트.md');
  });

  it('이미 절대 경로면 그대로 둔다', () => {
    expect(resolveDocPath('/work/a.md', '/etc/hosts')).toBe('/etc/hosts');
    expect(resolveDocPath('/work/a.md', 'D:\\other\\b.md')).toBe('D:\\other\\b.md');
  });

  it('문서 위치를 모르면 상대 경로를 풀 수 없다', () => {
    expect(resolveDocPath(null, 'b.md')).toBeNull();
    expect(resolveDocPath('/work/a.md', '   ')).toBeNull();
    expect(resolveDocPath('/work/a.md', '#앵커만')).toBeNull();
  });
});
