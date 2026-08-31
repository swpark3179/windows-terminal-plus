import { describe, expect, it } from 'vitest';
import { esc, mdToHtml } from './markdown';

describe('esc', () => {
  it('꺾쇠와 앰퍼샌드를 이스케이프한다', () => {
    expect(esc('<script>&')).toBe('&lt;script&gt;&amp;');
  });
});

describe('mdToHtml', () => {
  it('제목 단계별로 크기가 달라진다', () => {
    expect(mdToHtml('# 큰제목')).toContain('font-size:1.55em');
    expect(mdToHtml('### 작은제목')).toContain('font-size:1.1em');
  });

  it('h1·h2 에만 밑줄이 붙는다', () => {
    expect(mdToHtml('## 둘')).toContain('border-bottom');
    expect(mdToHtml('#### 넷')).not.toContain('border-bottom');
  });

  it('표를 thead/tbody 로 만든다', () => {
    const html = mdToHtml(['| 크레이트 | 역할 |', '| --- | --- |', '| `rterm-core` | 세션 |'].join('\n'));
    expect(html).toContain('<thead>');
    expect(html).toContain('크레이트');
    expect(html).toContain('세션');
    // 구분선 행은 셀로 새어 나오지 않는다.
    expect(html).not.toContain('---');
  });

  it('체크박스 목록을 기호로 바꾼다', () => {
    const html = mdToHtml(['- [x] 완료된 것', '- [ ] 남은 것', '- 그냥 항목'].join('\n'));
    expect(html).toContain('☑');
    expect(html).toContain('☐');
    expect(html).toContain('그냥 항목');
    expect(html).not.toContain('[x]');
  });

  it('코드 펜스 안은 이스케이프되고 서식이 적용되지 않는다', () => {
    const html = mdToHtml(['```rust', 'let a = &b<c>;', '**굵지 않음**', '```'].join('\n'));
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;c&gt;');
    expect(html).not.toContain('<b>굵지 않음</b>');
  });

  it('인용을 강조색 왼쪽 선으로 만든다', () => {
    expect(mdToHtml('> 메모')).toContain('border-left:3px solid #c96442');
  });

  it('인라인 코드·굵게·기울임·링크를 처리한다', () => {
    const html = mdToHtml('`code` **굵게** *기울임* [링크](https://example.com)');
    expect(html).toContain('md-inline-code');
    expect(html).toContain('<b>굵게</b>');
    expect(html).toContain('<i>기울임</i>');
    expect(html).toContain('href="https://example.com"');
  });

  it('본문의 HTML 은 이스케이프해 삽입을 막는다', () => {
    const html = mdToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('빈 줄은 버린다', () => {
    expect(mdToHtml('a\n\n\nb')).toBe(
      '<div style="margin:.4em 0">a</div><div style="margin:.4em 0">b</div>',
    );
  });

  it('빈 입력에도 안전하다', () => {
    expect(mdToHtml('')).toBe('');
  });
});

describe('코드 블록과 mermaid', () => {
  const fence = (...lines: string[]) => mdToHtml(lines.join('\n'));

  it('코드 블록에 언어 배지와 복사 버튼이 붙는다', () => {
    const html = fence('```rust', 'let a = 1;', '```');
    expect(html).toContain('md-code__lang">rust<');
    expect(html).toContain('md-code__copy');
    expect(html).toContain('class="language-rust"');
    expect(html).toContain('md-code__body');
  });

  it('언어를 적지 않으면 text 로 표시한다', () => {
    expect(fence('```', 'plain', '```')).toContain('md-code__lang">text<');
  });

  it('코드 본문은 여전히 이스케이프된다', () => {
    const html = fence('```rust', 'let a = &b<c>;', '**굵지 않음**', '```');
    expect(html).toContain('&lt;c&gt;');
    expect(html).not.toContain('<b>굵지 않음</b>');
  });

  it('복사 속성의 따옴표를 막아 속성이 깨지지 않게 한다', () => {
    const html = fence('```js', 'const a = "값";', '```');
    expect(html).toContain('&quot;');
    // data-copy 안에 생짜 큰따옴표가 남으면 안 된다.
    const attr = html.match(/data-copy="([^"]*)"/)![1];
    expect(attr).not.toContain('"');
    expect(attr).toContain('&quot;');
  });

  it('mermaid 블록은 다이어그램 자리로 남는다', () => {
    const html = fence('```mermaid', 'graph TD;', '  A-->B;', '```');
    expect(html).toContain('class="md-mermaid"');
    expect(html).toContain('data-mermaid=');
    expect(html).toContain('다이어그램 그리는 중…');
    // 일반 코드 블록으로 새지 않는다.
    expect(html).not.toContain('md-code__body');
  });

  it('mermaid 원본의 꺾쇠도 이스케이프된다', () => {
    const html = fence('```mermaid', 'graph LR; A-->B;', '```');
    const attr = html.match(/data-mermaid="([^"]*)"/)![1];
    expect(attr).toContain('--&gt;');
    expect(attr).not.toContain('>');
  });

  it('MERMAID 처럼 대문자로 써도 알아본다', () => {
    expect(fence('```MERMAID', 'graph TD;', '```')).toContain('md-mermaid');
  });
});
