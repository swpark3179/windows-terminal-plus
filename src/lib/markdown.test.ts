import { describe, expect, it } from 'vitest';
import { esc, inline, mdToHtml, slugify } from './markdown';

describe('esc', () => {
  it('꺾쇠와 앰퍼샌드를 이스케이프한다', () => {
    expect(esc('<script>&')).toBe('&lt;script&gt;&amp;');
  });
});

describe('제목', () => {
  it('단계마다 다른 클래스를 붙인다', () => {
    expect(mdToHtml('# 큰제목')).toContain('<h1 class="md-head md-head--1"');
    expect(mdToHtml('### 작은제목')).toContain('<h3 class="md-head md-head--3"');
    // 디자인 시절에는 4단계까지였다 — GFM 대로 6 단계를 모두 받는다.
    expect(mdToHtml('###### 여섯')).toContain('<h6 class="md-head md-head--6"');
  });

  it('목차가 찾을 수 있게 순번과 단계를 남긴다', () => {
    const html = mdToHtml(['# 하나', '## 둘'].join('\n'));
    expect(html).toContain('data-md-heading="0" data-md-level="1"');
    expect(html).toContain('data-md-heading="1" data-md-level="2"');
  });

  it('`#링크` 가 가리킬 앵커 이름을 붙인다', () => {
    expect(mdToHtml('## 설계 노트')).toContain('id="설계-노트"');
    // 같은 제목이 두 번 나오면 뒤엣것에 번호가 붙는다.
    const twice = mdToHtml(['## 메모', '## 메모'].join('\n'));
    expect(twice).toContain('id="메모"');
    expect(twice).toContain('id="메모-1"');
  });

  it('앵커 이름에서 서식과 기호를 걷어낸다', () => {
    expect(slugify('**굵은** 제목!')).toBe('굵은-제목');
    expect(slugify('Getting Started')).toBe('getting-started');
  });

  it('밑줄 제목(setext)도 알아본다', () => {
    expect(mdToHtml(['제목', '===='].join('\n'))).toContain('md-head--1');
    expect(mdToHtml(['제목', '----'].join('\n'))).toContain('md-head--2');
  });

  it('닫는 우물정자는 제목 글자가 아니다', () => {
    expect(mdToHtml('## 가운데 ##')).toContain('>가운데</h2>');
  });
});

describe('문단', () => {
  it('이어지는 줄을 한 문단으로 묶는다', () => {
    // 예전에는 줄마다 div 하나였다 — 원문의 줄바꿈이 화면의 줄바꿈이 돼 버렸다.
    expect(mdToHtml('a\nb')).toBe('<p class="md-p">a\nb</p>');
  });

  it('빈 줄에서 문단을 끊는다', () => {
    expect(mdToHtml('a\n\n\nb')).toBe('<p class="md-p">a</p><p class="md-p">b</p>');
  });

  it('줄 끝의 공백 두 칸은 진짜 줄바꿈이다', () => {
    expect(mdToHtml('a  \nb')).toBe('<p class="md-p">a<br>b</p>');
    expect(mdToHtml('a\\\nb')).toBe('<p class="md-p">a<br>b</p>');
  });

  it('빈 입력에도 안전하다', () => {
    expect(mdToHtml('')).toBe('');
  });
});

describe('목록', () => {
  it('번호 목록을 ol 로 만든다', () => {
    const html = mdToHtml(['1. 하나', '2. 둘'].join('\n'));
    expect(html).toContain('<ol class="md-list md-list--ord"');
    expect(html).toContain('하나');
  });

  it('1 이 아닌 수로 시작하면 그 번호부터 센다', () => {
    expect(mdToHtml('3. 셋')).toContain('start="3"');
    expect(mdToHtml('1. 하나')).not.toContain('start=');
  });

  it('들여쓴 항목을 자식 목록으로 넣는다', () => {
    const html = mdToHtml(['- 겉', '  - 속', '- 겉2'].join('\n'));
    // 자식 목록이 부모 <li> 안에서 닫힌다.
    expect(html).toContain('<li class="md-item">겉<ul class="md-list md-list--bul">');
    expect(html).toContain('<li class="md-item">속</li></ul></li>');
  });

  it('글머리와 번호가 섞이면 목록을 나눈다', () => {
    const html = mdToHtml(['- 글머리', '1. 번호'].join('\n'));
    expect(html).toContain('</ul><ol');
  });

  it('체크박스 목록을 기호로 바꾼다', () => {
    const html = mdToHtml(['- [x] 완료된 것', '- [ ] 남은 것', '- 그냥 항목'].join('\n'));
    expect(html).toContain('☑');
    expect(html).toContain('md-task--done');
    expect(html).toContain('☐');
    expect(html).toContain('그냥 항목');
    expect(html).not.toContain('[x]');
  });

  it('항목보다 깊이 들여 쓴 줄은 그 항목의 이어쓰기다', () => {
    const html = mdToHtml(['- 첫 줄', '  이어지는 줄'].join('\n'));
    expect(html).toContain('첫 줄 이어지는 줄');
  });

  it('빈 줄 하나는 목록을 끊지 않는다', () => {
    const html = mdToHtml(['- 하나', '', '- 둘'].join('\n'));
    expect(html.match(/<ul/g)).toHaveLength(1);
  });
});

describe('표', () => {
  it('표를 thead/tbody 로 만든다', () => {
    const html = mdToHtml(
      ['| 크레이트 | 역할 |', '| --- | --- |', '| `rterm-core` | 세션 |'].join('\n'),
    );
    expect(html).toContain('<thead>');
    expect(html).toContain('크레이트');
    expect(html).toContain('세션');
    // 구분선 행은 셀로 새어 나오지 않는다.
    expect(html).not.toContain('---');
  });

  it('구분줄의 콜론에서 열 정렬을 읽는다', () => {
    const html = mdToHtml(['| a | b | c |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'].join('\n'));
    expect(html).toContain('md-cell--left');
    expect(html).toContain('md-cell--center');
    expect(html).toContain('md-cell--right');
  });

  it('머리줄이 없으면 표가 아니라 문단이다', () => {
    expect(mdToHtml('| 그냥 파이프 |')).toContain('<p class="md-p">');
  });

  it('셀이 모자란 줄도 열 수를 맞춰 채운다', () => {
    const html = mdToHtml(['| a | b |', '| --- | --- |', '| 1 |'].join('\n'));
    expect(html.match(/<td/g)).toHaveLength(2);
  });
});

describe('인용 · 가로줄 · front matter', () => {
  it('인용을 blockquote 로 만든다', () => {
    expect(mdToHtml('> 메모')).toBe(
      '<blockquote class="md-quote"><p class="md-p">메모</p></blockquote>',
    );
  });

  it('여러 줄 인용과 인용 안의 목록을 함께 다룬다', () => {
    const html = mdToHtml(['> 첫 줄', '> - 항목'].join('\n'));
    expect(html).toContain('<blockquote class="md-quote">');
    expect(html).toContain('<ul class="md-list');
  });

  it('가로줄을 알아본다', () => {
    expect(mdToHtml('---')).toBe('<hr class="md-rule">');
    expect(mdToHtml('***')).toBe('<hr class="md-rule">');
    // 목록 항목은 가로줄이 아니다.
    expect(mdToHtml('- 항목')).toContain('<ul');
  });

  it('맨 앞의 front matter 는 본문과 따로 보여 준다', () => {
    const html = mdToHtml(['---', 'title: 메모', '---', '# 본문'].join('\n'));
    expect(html).toContain('md-front__label');
    expect(html).toContain('title: 메모');
    expect(html).toContain('md-head--1');
    // 여는 `---` 가 가로줄로 새지 않는다.
    expect(html).not.toContain('md-rule');
  });

  it('닫히지 않은 front matter 는 그냥 가로줄이다', () => {
    expect(mdToHtml(['---', '본문'].join('\n'))).toContain('md-rule');
  });
});

describe('인라인 서식', () => {
  it('인라인 코드·굵게·기울임·취소선·링크를 처리한다', () => {
    const html = mdToHtml('`code` **굵게** *기울임* ~~지움~~ [링크](https://example.com)');
    expect(html).toContain('md-inline-code');
    expect(html).toContain('<b>굵게</b>');
    expect(html).toContain('<i>기울임</i>');
    expect(html).toContain('md-strike');
    expect(html).toContain('href="https://example.com"');
  });

  it('코드 스팬 안의 별표는 서식이 아니다', () => {
    expect(inline('`a*b*c`')).toBe('<code class="md-inline-code">a*b*c</code>');
  });

  it('낱말 안의 밑줄은 기울임으로 둔갑하지 않는다', () => {
    // 예전 렌더러가 `snake_case_name` 을 `snake<i>case</i>name` 으로 만들던 자리다.
    expect(inline('snake_case_name')).toBe('snake_case_name');
    expect(inline('a_b_c_d')).toBe('a_b_c_d');
    expect(inline('_진짜 기울임_')).toBe('<i>진짜 기울임</i>');
    // 낱말 경계에 걸린 `__init__` 은 GFM 도 굵게 그린다 — 여기서도 같게 둔다.
    expect(inline('__init__')).toBe('<b>init</b>');
  });

  it('본문의 HTML 은 이스케이프해 삽입을 막는다', () => {
    const html = mdToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('링크와 그림', () => {
  it('주소 종류를 표식으로 남긴다 — 열 곳이 다르기 때문이다', () => {
    expect(mdToHtml('[밖](https://example.com)')).toContain('data-md-link="ext"');
    expect(mdToHtml('[안](#제목)')).toContain('data-md-link="anchor"');
    expect(mdToHtml('[옆](./guide.md)')).toContain('data-md-link="rel"');
  });

  it('`javascript:` 주소는 링크로 만들지 않는다', () => {
    const html = mdToHtml('[누르지 마세요](javascript:alert(1))');
    expect(html).toContain('md-link--blocked');
    expect(html).not.toContain('<a');
  });

  it('링크 글자 안의 서식도 살린다', () => {
    expect(mdToHtml('[**굵은** 링크](https://a.com)')).toContain('<b>굵은</b>');
  });

  it('꺾쇠 자동 링크를 처리한다', () => {
    expect(mdToHtml('<https://example.com>')).toContain('href="https://example.com"');
  });

  it('웹 그림은 그리고, 읽을 수 없는 경로는 자리만 남긴다', () => {
    expect(mdToHtml('![로고](https://a.com/x.png)')).toContain('<img class="md-img"');
    const local = mdToHtml('![그림](./shot.png)');
    expect(local).toContain('md-img-miss');
    expect(local).not.toContain('<img');
  });

  it('그림이 링크로 새지 않는다', () => {
    expect(mdToHtml('![alt](https://a.com/x.png)')).not.toContain('<a ');
  });

  it('속성 안에서 따옴표가 빠져나가지 못한다', () => {
    const html = mdToHtml('![x](https://a.com/"onerror="alert(1))');
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('&quot;');
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

  it('코드 본문은 이스케이프되고 서식이 적용되지 않는다', () => {
    const html = fence('```rust', 'let a = &b<c>;', '**굵지 않음**', '```');
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;c&gt;');
    expect(html).not.toContain('<b>굵지 않음</b>');
  });

  it('물결 펜스도 받는다', () => {
    expect(fence('~~~python', 'x = 1', '~~~')).toContain('md-code__lang">python<');
  });

  it('펜스 안의 짧은 펜스는 블록을 닫지 않는다', () => {
    const html = fence('````md', '```', 'inner', '```', '````');
    expect(html.match(/md-code__body/g)).toHaveLength(1);
    expect(html).toContain('inner');
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
