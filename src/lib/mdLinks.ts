/**
 * 마크다운 본문의 링크를 어디로 보낼지 가르는 규칙.
 *
 * 뷰어 안에서 링크는 세 갈래다.
 *
 * - **바깥 주소** — OS 기본 브라우저로 넘긴다 (`link_open`). 웹뷰가 문서 자리에서 그대로
 *   이동해 버리면 뷰어가 통째로 사라진다.
 * - **`#앵커`** — 같은 문서 안의 제목으로 스크롤.
 * - **옆 파일** (`./guide.md` · `docs/api.md`) — 빈 블럭에 그 파일을 연다. 저장소 문서는
 *   서로를 이렇게 가리키므로, 여기서 끊기면 뷰어로 문서를 따라 읽을 수 없다.
 *
 * 그 밖의 스킴(`javascript:` · `data:` · `file:`)은 링크로 만들지도 않는다.
 */

export type HrefKind = 'ext' | 'anchor' | 'rel' | 'blocked';

export function classifyHref(href: string): HrefKind {
  const raw = href.trim();
  if (!raw) return 'blocked';
  if (raw.startsWith('#')) return 'anchor';
  if (/^(https?|mailto):/i.test(raw)) return 'ext';
  // 스킴이 붙어 있는데 위에서 걸리지 않았다면 우리가 다룰 수 있는 주소가 아니다.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return 'blocked';
  return 'rel';
}

/** 이 경로가 이미 절대 경로인가 (`C:\…` · `\\서버\…` · `/…`). */
function absolute(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/**
 * 문서 옆의 상대 경로를 실제 경로로 바꾼다.
 *
 * 구분자는 **문서 경로가 쓰던 것**을 따른다 — 윈도우에서 온 `C:\work\docs\a.md` 는
 * 역슬래시로, 테스트나 WSL 의 `/work/docs/a.md` 는 슬래시로 돌아간다.
 * 문서 폴더 위로 올라가는 `..` 은 그대로 받는다: 저장소 문서가 `../README.md` 를 가리키는 것은
 * 흔한 일이고, 여기서 막아 봐야 파일 피커로는 어차피 열 수 있다.
 */
export function resolveDocPath(docPath: string | null | undefined, rel: string): string | null {
  const target = rel.trim().replace(/[#?].*$/, '');
  if (!target) return null;

  let decoded = target;
  try {
    decoded = decodeURI(target);
  } catch {
    // 잘못 인코딩된 주소는 적힌 그대로 쓴다.
  }

  if (absolute(decoded)) return decoded;
  if (!docPath) return null;

  const sep = docPath.includes('\\') ? '\\' : '/';
  const parts = docPath.split(/[\\/]/);
  parts.pop(); // 문서 이름을 떼고 그 폴더에서 출발한다.

  for (const piece of decoded.split(/[\\/]/)) {
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(piece);
  }
  return parts.join(sep);
}
