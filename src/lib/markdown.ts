/**
 * 마크다운 뷰어 렌더러.
 *
 * 처음에는 디자인 스크립트의 `mdToHtml` 을 그대로 옮긴, 한 줄씩 훑는 짧은 함수였다.
 * 지금은 참고 저장소(`swpark3179/markdown-viewer`)가 `marked` 로 얻던 표시 범위 —
 * 번호 목록 · 중첩 목록 · 정렬이 붙은 표 · 여러 줄 인용 · 가로줄 · 이미지 · 취소선 ·
 * 문단 잇기 · 제목 앵커 — 를 직접 다룬다. 라이브러리를 들이지 않은 이유는 두 가지다.
 *
 * 1. **삽입 차단.** 본문의 HTML 은 언제나 이스케이프한다. 마크다운 파일은 남이 준 것일 수
 *    있고, 이 앱의 웹뷰에는 터미널과 파일 시스템이 붙어 있다. `marked` 는 기본적으로 원시
 *    HTML 을 통과시키므로 살균기를 하나 더 얹어야 한다.
 * 2. 표시 규칙이 코드에 그대로 보이면 테스트로 못 박을 수 있다.
 *
 * 서식은 전부 클래스로 나가고 색·간격은 `styles/app.css` 가 정한다 — 뷰어의 밝은/어두운
 * 테마가 같은 HTML 위에서 갈리려면 인라인 스타일이 없어야 한다.
 */

import { classifyHref } from './mdLinks';

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 속성값 안에 넣을 때는 따옴표까지 막아야 한다. */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 이미 이스케이프된 글자에서 속성에 쓸 수 있는 꼴로. `esc` 를 두 번 거치지 않는다. */
function attr(escaped: string): string {
  return escaped.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 렌더링 한 번 동안 이어지는 값 — 제목 번호와 앵커 이름. */
interface Ctx {
  heads: number;
  slugs: Map<string, number>;
}

// ── 인라인 ────────────────────────────────────────────────

/** 인라인 처리 중 코드·링크·그림을 잠시 빼 두는 자리표 울타리. */
const HOLD = '\u0000';

/** 굵게 · 기울임 · 취소선. 이미 이스케이프된 글자 위에서 돈다. */
function emphasis(s: string): string {
  return (
    s
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      // `__bold__` · `_italic_` 은 단어 안(`__init__` · `snake_case`)에서는 서식이 아니다.
      .replace(/(^|[^\w_])__([^_\n]+)__(?!\w)/g, '$1<b>$2</b>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s class="md-strike">$1</s>')
  );
}

/**
 * 링크 한 개.
 *
 * 주소의 종류에 따라 표시와 표식이 갈린다 — 바깥 주소는 OS 브라우저로, `#` 은 문서 안
 * 이동으로, 옆 파일은 새 창으로 여는 길을 `MarkdownPane` 이 이 표식을 보고 정한다.
 * `javascript:` 같은 주소는 아예 링크로 만들지 않는다.
 */
function linkHtml(label: string, href: string, title?: string): string {
  const kind = classifyHref(href);
  const text = emphasis(label) || attr(href);
  const tip = title ? ` title="${attr(title)}"` : '';

  if (kind === 'blocked') {
    return `<span class="md-link md-link--blocked" title="열 수 없는 주소">${text}</span>`;
  }
  return (
    `<a class="md-link md-link--${kind}" href="${attr(href)}" data-md-link="${kind}"${tip}>` +
    `${text}</a>`
  );
}

/**
 * 그림 한 장.
 *
 * 웹 주소와 data URL 만 실제로 그린다. 파일 옆의 `./shot.png` 같은 상대 경로는 웹뷰가 직접
 * 읽을 수 없으므로(Rust 를 거쳐야 한다) 자리와 경로를 보여 주는 쪽을 고른다 — 아무것도 없는
 * 깨진 그림보다 무엇이 있어야 하는지 알려 주는 편이 낫다.
 */
function imageHtml(alt: string, src: string, title?: string): string {
  const drawable = /^(https?:\/\/|data:image\/)/i.test(src);
  const tip = title ? ` title="${attr(title)}"` : ` title="${attr(src)}"`;
  if (drawable) {
    return `<img class="md-img" src="${attr(src)}" alt="${attr(alt)}" loading="lazy"${tip}>`;
  }
  return (
    `<span class="md-img-miss"${tip}><span class="md-img-miss__icon">▨</span>` +
    `<span class="md-img-miss__alt">${emphasis(alt) || attr(src)}</span></span>`
  );
}

/**
 * 인라인 서식 전체.
 *
 * 코드 스팬 · 그림 · 링크는 먼저 자리표로 빼 둔다. 그러지 않으면 `` `a*b*c` `` 의 별표나
 * 주소 안의 밑줄이 기울임으로 둔갑한다.
 */
export function inline(raw: string): string {
  const slots: string[] = [];
  // 자리표는 본문에 절대 나올 수 없는 글자로 감싼다 (NUL 이 든 파일은 백엔드가 이미 거른다).
  const hold = (html: string) => `${HOLD}${slots.push(html) - 1}${HOLD}`;

  let s = esc(raw);

  // 코드 스팬 — 여는 백틱 수와 닫는 수가 같아야 한다 (`` `a` `` 안의 백틱을 위해).
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, body: string) =>
    hold(`<code class="md-inline-code">${body.replace(/^ (.*) $/, '$1')}</code>`),
  );

  // 그림이 링크보다 먼저다 — `![alt](src)` 가 링크로 새지 않도록.
  const target = /\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/.source;
  s = s.replace(new RegExp(`!\\[([^\\]]*)\\]${target}`, 'g'), (_m, alt, src, title) =>
    hold(imageHtml(alt, src, title)),
  );
  s = s.replace(new RegExp(`\\[([^\\]]*)\\]${target}`, 'g'), (_m, label, href, title) =>
    hold(linkHtml(label, href, title)),
  );

  // `<https://…>` 꼴 자동 링크. `esc` 를 지났으므로 꺾쇠는 엔티티다.
  s = s.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (_m, url: string) =>
    hold(linkHtml(url, url)),
  );

  s = emphasis(s);
  return s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_m, i: string) => slots[Number(i)]);
}

// ── 제목 앵커 ─────────────────────────────────────────────

/**
 * 제목 글자를 `#링크` 가 가리킬 수 있는 이름으로.
 * 깃허브와 같은 규칙 — 소문자, 기호는 빼고, 공백은 `-`. 한글은 그대로 둔다.
 */
export function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  return base || 'section';
}

function uniqueSlug(ctx: Ctx, text: string): string {
  const base = slugify(text);
  const seen = ctx.slugs.get(base) ?? 0;
  ctx.slugs.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

/** 인라인 서식을 벗겨 낸 제목 글자 — 목차와 앵커 이름에 쓴다. */
function plain(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
}

// ── 블록 ──────────────────────────────────────────────────

const RE = {
  fence: /^ {0,3}(```+|~~~+)\s*([^`\s]*)/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  rule: /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/,
  quote: /^ {0,3}>\s?/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/,
  table: /^ {0,3}\|/,
  delimiter: /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/,
  setext: /^ {0,3}(=+|-+)\s*$/,
  task: /^\[([ xX])\]\s+/,
};

/** 이 줄에서 다른 블록이 시작되는가 — 문단을 어디서 끊을지 정한다. */
function startsBlock(line: string): boolean {
  return (
    !line.trim() ||
    RE.fence.test(line) ||
    RE.heading.test(line) ||
    RE.rule.test(line) ||
    RE.quote.test(line) ||
    RE.item.test(line) ||
    RE.table.test(line)
  );
}

interface Item {
  indent: number;
  ordered: boolean;
  /** `1.` 의 1 — 목록이 1 이 아닌 수로 시작할 때 쓴다. */
  start: number;
  text: string;
}

/** 들여쓰기 깊이만큼 중첩된 `<ul>`/`<ol>` 을 만든다. */
function buildList(items: Item[], from: number, ctx: Ctx): [string, number] {
  const base = items[from].indent;
  const ordered = items[from].ordered;
  const start = items[from].start;
  const cells: string[] = [];
  let i = from;

  while (i < items.length) {
    const item = items[i];
    if (item.indent < base) break;

    if (item.indent > base) {
      // 더 깊이 들어간 줄은 방금 만든 항목의 자식 목록이다.
      const [child, next] = buildList(items, i, ctx);
      if (cells.length === 0) cells.push('');
      cells[cells.length - 1] += child;
      i = next;
      continue;
    }
    if (item.ordered !== ordered) break;

    const task = item.text.match(RE.task);
    const body = inline(item.text.replace(RE.task, ''));
    cells.push(
      task
        ? `<li class="md-item md-item--task">` +
            `<span class="md-task${/x/i.test(task[1]) ? ' md-task--done' : ''}">` +
            `${/x/i.test(task[1]) ? '☑' : '☐'}</span>${body}`
        : `<li class="md-item">${body}`,
    );
    i += 1;
  }

  const tag = ordered ? 'ol' : 'ul';
  const cls = `md-list md-list--${ordered ? 'ord' : 'bul'}`;
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
  const html = `<${tag} class="${cls}"${startAttr}>${cells.map((c) => `${c}</li>`).join('')}</${tag}>`;
  return [html, i];
}

/** `| --- | :--: |` 구분줄에서 열별 정렬을 읽는다. */
function alignments(row: string): ('left' | 'center' | 'right')[] {
  return splitRow(row).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : 'left';
  });
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/** 코드 펜스 한 덩이 — 일반 코드 카드거나, 다이어그램 자리. */
function fenceHtml(language: string, body: string): string {
  if (language === 'mermaid') {
    return (
      `<div class="md-mermaid" data-mermaid="${escAttr(body)}">` +
      '<div class="md-mermaid__pending">다이어그램 그리는 중…</div>' +
      '</div>'
    );
  }
  const label = language || 'text';
  return (
    '<div class="md-code">' +
    '<div class="md-code__head">' +
    `<span class="md-code__lang">${esc(label)}</span>` +
    `<button class="md-code__copy" type="button" data-copy="${escAttr(body)}">복사</button>` +
    '</div>' +
    `<pre class="md-code__body"><code class="language-${escAttr(label)}">${esc(body)}</code></pre>` +
    '</div>'
  );
}

function headingHtml(level: number, text: string, ctx: Ctx): string {
  const index = ctx.heads++;
  const id = uniqueSlug(ctx, plain(text));
  return (
    `<h${level} class="md-head md-head--${level}" id="${attr(escAttr(id))}"` +
    ` data-md-heading="${index}" data-md-level="${level}">${inline(text)}</h${level}>`
  );
}

/** 줄 묶음을 HTML 로. 인용 안에서도 같은 함수가 다시 돈다. */
function renderBlocks(lines: string[], ctx: Ctx): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 코드 펜스 — 열린 펜스와 같은 글자·같은 길이 이상으로만 닫힌다.
    const fence = line.match(RE.fence);
    if (fence) {
      const marker = fence[1][0];
      const width = fence[1].length;
      const closing = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${width},}\\s*$`);
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(fenceHtml((fence[2] || '').toLowerCase(), buf.join('\n')));
      continue;
    }

    // 표 — 머리줄 바로 아래에 구분줄이 있어야 표다 (GFM 규칙).
    if (RE.table.test(line) && i + 1 < lines.length && RE.delimiter.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = alignments(lines[i + 1]);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && RE.table.test(lines[i])) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
      const cell = (tag: string, text: string, n: number) =>
        `<${tag} class="md-cell md-cell--${align[n] ?? 'left'}">${inline(text)}</${tag}>`;
      out.push(
        '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
          head.map((h, n) => cell('th', h, n)).join('') +
          '</tr></thead><tbody>' +
          body
            .map((row) => `<tr>${head.map((_, n) => cell('td', row[n] ?? '', n)).join('')}</tr>`)
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    const heading = line.match(RE.heading);
    if (heading) {
      out.push(headingHtml(heading[1].length, heading[2], ctx));
      i += 1;
      continue;
    }

    if (RE.rule.test(line)) {
      out.push('<hr class="md-rule">');
      i += 1;
      continue;
    }

    // 인용 — 이어지는 `>` 줄과 그 뒤에 바로 붙는 줄(느슨한 이어쓰기)까지 한 덩이.
    if (RE.quote.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        if (RE.quote.test(lines[i])) buf.push(lines[i].replace(RE.quote, ''));
        else if (buf.length > 0 && !startsBlock(lines[i])) buf.push(lines[i]);
        else break;
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(buf, ctx)}</blockquote>`);
      continue;
    }

    // 목록 — 빈 줄 하나를 사이에 둔 다음 항목까지 같은 목록으로 본다.
    if (RE.item.test(line)) {
      const items: Item[] = [];
      while (i < lines.length) {
        const match = lines[i].match(RE.item);
        if (match) {
          const marker = match[2];
          items.push({
            indent: match[1].replace(/\t/g, '  ').length,
            ordered: /\d/.test(marker),
            start: Number.parseInt(marker, 10) || 1,
            text: match[3],
          });
          i += 1;
          continue;
        }
        // 항목보다 깊이 들여 쓴 줄은 그 항목의 이어쓰기다.
        if (items.length > 0 && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !startsBlock(lines[i])) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        // 빈 줄 하나는 목록을 끊지 않는다 — 다음 줄이 다시 항목이면 이어진다.
        if (!lines[i].trim() && i + 1 < lines.length && RE.item.test(lines[i + 1])) {
          i += 1;
          continue;
        }
        break;
      }
      // 글머리와 번호가 섞여 있으면 `buildList` 가 거기서 멈춘다 — 남은 항목으로 다음 목록을
      // 이어 만든다. 한 번만 부르면 뒤엣것이 통째로 사라진다.
      let at = 0;
      while (at < items.length) {
        const [html, next] = buildList(items, at, ctx);
        out.push(html);
        at = next > at ? next : at + 1;
      }
      continue;
    }

    // 밑줄 제목 (`제목` 다음 줄에 `===` 또는 `---`).
    if (i + 1 < lines.length && RE.setext.test(lines[i + 1])) {
      out.push(headingHtml(lines[i + 1].trim().startsWith('=') ? 1 : 2, line.trim(), ctx));
      i += 2;
      continue;
    }

    // 문단 — 다음 블록이 시작될 때까지 이어 붙인다.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      if (i + 1 < lines.length && RE.setext.test(lines[i + 1])) break;
      buf.push(lines[i]);
      i += 1;
    }
    if (buf.length === 0) {
      // 어떤 분기도 이 줄을 가져가지 못하는 일은 없어야 하지만, 나면 멈추지 않고 넘긴다.
      buf.push(lines[i]);
      i += 1;
    }
    const parts: string[] = [];
    buf.forEach((raw, n) => {
      // 줄 끝의 공백 두 칸이나 역슬래시는 "여기서 줄을 바꾸라" 는 뜻이다.
      const hard = /(\s{2,}|\\)$/.test(raw);
      parts.push(inline(raw.replace(/(\s{2,}|\\)$/, '').trim()));
      if (n < buf.length - 1) parts.push(hard ? '<br>' : '\n');
    });
    out.push(`<p class="md-p">${parts.join('')}</p>`);
  }

  return out.join('');
}

/** 문서 맨 앞의 `---` 블록 — 내용이 아니라 메타데이터라 따로 접어서 보여 준다. */
function frontMatter(lines: string[]): { html: string; skip: number } | null {
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      const body = lines.slice(1, i).join('\n');
      return {
        html:
          '<div class="md-front"><div class="md-front__label">front matter</div>' +
          `<pre class="md-front__body">${esc(body)}</pre></div>`,
        skip: i + 1,
      };
    }
  }
  return null;
}

export function mdToHtml(src: string): string {
  const lines = String(src ?? '').split('\n');
  const ctx: Ctx = { heads: 0, slugs: new Map() };
  const front = frontMatter(lines);
  const body = renderBlocks(front ? lines.slice(front.skip) : lines, ctx);
  return (front?.html ?? '') + body;
}
