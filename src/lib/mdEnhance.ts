/**
 * 마크다운 뷰어 후처리 — 문법 강조 · mermaid 다이어그램 · 복사 버튼.
 *
 * 둘 다 무거운 라이브러리라 필요한 블록이 실제로 있을 때만 동적으로 불러온다.
 * (마크다운을 열지 않는 세션에서는 아예 로드되지 않는다.)
 */

import { writeClipboardText } from '../ipc/bridge';

/** 자주 쓰는 언어만 등록해 번들을 줄인다. */
const LANGUAGES: Record<string, () => Promise<{ default: unknown }>> = {
  rust: () => import('highlight.js/lib/languages/rust'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  sql: () => import('highlight.js/lib/languages/sql'),
  diff: () => import('highlight.js/lib/languages/diff'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
};

/** 흔한 별칭을 위 표의 이름으로 맞춘다. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  golang: 'go',
  'c++': 'cpp',
  c: 'cpp',
  cs: 'csharp',
  html: 'xml',
  svg: 'xml',
  yml: 'yaml',
  toml: 'ini',
  md: 'markdown',
  rs: 'rust',
};

type Hljs = typeof import('highlight.js/lib/core').default;

let hljsPromise: Promise<Hljs> | null = null;
const registered = new Set<string>();

async function getHljs(): Promise<Hljs> {
  if (!hljsPromise) {
    hljsPromise = import('highlight.js/lib/core').then((m) => m.default);
  }
  return hljsPromise;
}

function normalise(language: string): string | null {
  const key = ALIASES[language] ?? language;
  return key in LANGUAGES ? key : null;
}

/** 코드 블록에 문법 강조를 입힌다. 모르는 언어는 그대로 둔다. */
export async function highlightCode(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre.md-code__body > code'));
  if (blocks.length === 0) return;

  const wanted = new Set<string>();
  for (const block of blocks) {
    const raw = (block.className.match(/language-([\w+#-]+)/)?.[1] ?? '').toLowerCase();
    const key = normalise(raw);
    if (key) wanted.add(key);
  }
  if (wanted.size === 0) return;

  const hljs = await getHljs();
  await Promise.all(
    Array.from(wanted).map(async (key) => {
      if (registered.has(key)) return;
      const mod = await LANGUAGES[key]();
      // 등록 이름은 표의 키를 그대로 쓴다.
      hljs.registerLanguage(key, mod.default as never);
      registered.add(key);
    }),
  );

  for (const block of blocks) {
    if (block.dataset.highlighted === 'yes') continue;
    const raw = (block.className.match(/language-([\w+#-]+)/)?.[1] ?? '').toLowerCase();
    const key = normalise(raw);
    if (!key) continue;
    try {
      block.innerHTML = hljs.highlight(block.textContent ?? '', { language: key }).value;
      block.dataset.highlighted = 'yes';
    } catch {
      // 강조에 실패해도 코드 자체는 그대로 남는다.
    }
  }
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
let diagramSeq = 0;

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: "'Roboto', 'Noto Sans KR', system-ui, sans-serif",
        // 앱의 종이색 팔레트에 맞춘 테마.
        themeVariables: {
          background: '#fffefb',
          primaryColor: '#fbf1ec',
          primaryTextColor: '#1f1e1d',
          primaryBorderColor: '#c96442',
          secondaryColor: '#f6f4ee',
          tertiaryColor: '#f2f0e9',
          lineColor: '#a04f2e',
          textColor: '#33312b',
          mainBkg: '#fbf1ec',
          nodeBorder: '#c96442',
          clusterBkg: '#f6f4ee',
          clusterBorder: '#dcd8cc',
          titleColor: '#1f1e1d',
        },
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

/** ```mermaid 블록을 실제 다이어그램으로 바꾼다. */
export async function renderMermaid(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid[data-mermaid]'));
  const pending = blocks.filter((b) => b.dataset.rendered !== 'yes');
  if (pending.length === 0) return;

  let mermaid: Awaited<ReturnType<typeof getMermaid>>;
  try {
    mermaid = await getMermaid();
  } catch {
    for (const block of pending) failDiagram(block, 'mermaid 를 불러오지 못했습니다');
    return;
  }

  for (const block of pending) {
    const source = block.dataset.mermaid ?? '';
    block.dataset.rendered = 'yes';
    try {
      const { svg } = await mermaid.render(`rterm-mermaid-${diagramSeq++}`, source);
      block.innerHTML = svg;
      block.classList.remove('md-mermaid--error');
    } catch (e) {
      failDiagram(block, e instanceof Error ? e.message : '다이어그램을 그릴 수 없습니다');
    }
  }
}

/** 문법이 틀리면 원본을 보여 준다 — 내용을 잃는 것보다 낫다. */
function failDiagram(block: HTMLElement, message: string) {
  const source = block.dataset.mermaid ?? '';
  block.classList.add('md-mermaid--error');
  block.dataset.rendered = 'yes';
  block.textContent = '';

  const note = document.createElement('div');
  note.className = 'md-mermaid__error';
  note.textContent = `다이어그램 오류 · ${message}`;

  const pre = document.createElement('pre');
  pre.className = 'md-mermaid__source';
  pre.textContent = source;

  block.append(note, pre);
}

/** 코드 블록의 복사 버튼을 붙인다. 이벤트 위임이라 한 번만 걸면 된다. */
export function wireCopyButtons(root: HTMLElement, onCopied: (label: string) => void) {
  const handler = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('.md-code__copy');
    if (!button) return;
    event.preventDefault();
    const text = button.dataset.copy ?? '';
    void writeClipboardText(text).then(
      () => onCopied('코드 복사됨'),
      () => onCopied('복사할 수 없습니다'),
    );
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}
