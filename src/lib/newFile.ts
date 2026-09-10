/**
 * 새 파일 이름을 만드는 자리에서 보여 주는 미리보기와 미리 걸러 내기.
 *
 * **판정의 주인은 Rust(`commands/files.rs` 의 `resolve_new_path`) 다.** 여기 있는 것은
 * 누르기 전에 알려 주기 위한 같은 규칙의 사본이고, 통과했다고 해서 파일이 만들어지는 것도
 * 아니다(이미 있는 이름인지는 디스크만 안다). 어긋나면 언제나 Rust 쪽이 맞다.
 */

import type { NewFileKind } from '../state/types';

export const NEW_FILE_KINDS: { key: NewFileKind; label: string; ext: string }[] = [
  { key: 'md', label: '마크다운', ext: '.md' },
  { key: 'txt', label: '텍스트', ext: '.txt' },
];

const BAD_CHARS = /[<>:"|?*]/;

/** 확장자를 적지 않았으면 고른 종류를 붙인 이름. 빈 이름은 그대로 빈 문자열. */
export function previewName(name: string, kind: NewFileKind): string {
  const raw = name.trim();
  if (!raw) return '';
  const last = raw.split(/[/\\]/).filter(Boolean).pop() ?? '';
  if (!last) return raw;
  return last.includes('.') ? raw : `${raw}.${kind}`;
}

/**
 * 이름이 확실히 틀렸을 때의 사유. 만들 수 있어 보이면 `null`.
 * 여기서 걸러 내면 만들기 버튼을 눌러 실패 토스트를 보기 전에 고칠 수 있다.
 */
export function nameProblem(name: string): string | null {
  const raw = name.trim();
  if (!raw) return null; // 아직 아무것도 안 적었을 뿐이다 — 나무라지 않는다.
  if (BAD_CHARS.test(raw)) return '이름에 < > : " | ? * 는 쓸 수 없습니다';
  if (raw.startsWith('/') || raw.startsWith('\\')) return '세션 폴더 아래의 이름만 쓸 수 있습니다';

  const parts = raw.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return '파일 이름을 적어 주세요';
  if (parts.some((p) => p === '.' || p === '..')) return '세션 폴더 밖으로는 만들 수 없습니다';
  if (parts.some((p) => p.endsWith('.') || p.endsWith(' '))) {
    return '이름 끝에 점이나 공백을 둘 수 없습니다';
  }
  return null;
}
