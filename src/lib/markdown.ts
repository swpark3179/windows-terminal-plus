/**
 * 마크다운 뷰어 렌더러 — 디자인 스크립트의 `mdToHtml` 을 그대로 옮겼다.
 * 서식(색·간격·표 테두리)은 디자인 값 그대로라 뷰어 모양이 1:1 로 재현된다.
 */

const ACCENT = '#c96442';

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 속성값 안에 넣을 때는 따옴표까지 막아야 한다. */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 인라인 서식: 코드 · 굵게 · 기울임 · 링크. */
function inline(t: string): string {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function mdToHtml(src: string): string {
  const lines = String(src ?? '').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 코드 펜스 — 언어 배지와 복사 버튼이 달린 블록.
    // ```mermaid 는 자리만 잡아 두고 `MarkdownPane` 이 다이어그램으로 바꾼다.
    const fence = line.match(/^```\s*([\w+#-]*)/);
    if (fence) {
      const language = (fence[1] || '').toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      const body = buf.join('\n');

      if (language === 'mermaid') {
        out.push(
          `<div class="md-mermaid" data-mermaid="${escAttr(body)}">` +
            '<div class="md-mermaid__pending">다이어그램 그리는 중…</div>' +
            '</div>',
        );
        continue;
      }

      const label = language || 'text';
      out.push(
        '<div class="md-code">' +
          '<div class="md-code__head">' +
          `<span class="md-code__lang">${esc(label)}</span>` +
          `<button class="md-code__copy" type="button" data-copy="${escAttr(body)}">복사</button>` +
          '</div>' +
          `<pre class="md-code__body"><code class="language-${escAttr(label)}">${esc(body)}</code></pre>` +
          '</div>',
      );
      continue;
    }

    // 표
    if (/^\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      const cells = (r: string) =>
        r
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((x) => x.trim());
      const body = rows.filter((r) => !/^\|[\s|:-]+\|?$/.test(r));
      if (body.length === 0) continue;
      const head = cells(body[0]);
      let html =
        '<table style="border-collapse:collapse;width:100%;margin:.7em 0;font-size:.94em"><thead><tr>' +
        head
          .map(
            (h) =>
              '<th style="border:1px solid #e2ded2;padding:6px 10px;text-align:left;background:#f6f4ee">' +
              `${inline(h)}</th>`,
          )
          .join('') +
        '</tr></thead><tbody>';
      body.slice(1).forEach((r) => {
        html +=
          '<tr>' +
          cells(r)
            .map((c) => `<td style="border:1px solid #e2ded2;padding:6px 10px">${inline(c)}</td>`)
            .join('') +
          '</tr>';
      });
      out.push(`${html}</tbody></table>`);
      continue;
    }

    // 목록 (체크박스 포함)
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*] /, ''));
        i++;
      }
      out.push(
        '<ul style="margin:.5em 0;padding-left:1.25em">' +
          items
            .map((t) => {
              const box = /^\[x\]/i.test(t)
                ? '<span style="color:#3f7a37">☑</span> '
                : /^\[ \]/.test(t)
                  ? '<span style="color:#a8a49a">☐</span> '
                  : '';
              return `<li style="margin:.15em 0">${box}${inline(t.replace(/^\[[x ]\]\s*/i, ''))}</li>`;
            })
            .join('') +
          '</ul>',
      );
      continue;
    }

    // 제목
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const size = [1.55, 1.28, 1.1, 1][h[1].length - 1];
      const rule = h[1].length <= 2 ? ';border-bottom:1px solid #e6e2d7;padding-bottom:.25em' : '';
      out.push(
        `<div style="font-size:${size}em;font-weight:700;margin:.9em 0 .4em${rule}">${inline(h[2])}</div>`,
      );
      i++;
      continue;
    }

    // 인용
    if (/^>\s?/.test(line)) {
      out.push(
        `<div style="border-left:3px solid ${ACCENT};background:#faf7f2;padding:9px 13px;` +
          `margin:.6em 0;color:#4a4741">${inline(line.replace(/^>\s?/, ''))}</div>`,
      );
      i++;
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    out.push(`<div style="margin:.4em 0">${inline(line)}</div>`);
    i++;
  }

  return out.join('');
}
