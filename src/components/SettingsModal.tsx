import { useEffect, useRef, useState, type ComponentProps } from 'react';

import { activeSession, useStore } from '../state/store';
import {
  DOT_COLORS,
  SHELL_LABELS,
  type AiKind,
  type EnvVar,
  type Session,
  type Shell,
} from '../state/types';
import { TextField } from './TextField';

/**
 * 설정 화면이 손에 쥐고 있는 값.
 *
 * 예전에는 칸을 고칠 때마다 곧바로 세션에 기록됐다 — 잘못 고친 것을 되돌릴 방법이 닫기밖에
 * 없었고, 그 닫기도 이미 기록된 뒤였다. 이제 고치는 동안에는 이 초안만 바뀌고,
 * **저장을 눌러야**(또는 입력칸에서 엔터) 세션으로 넘어간다. 닫기는 초안을 버릴 뿐이다.
 */
interface Draft {
  name: string;
  cwd: string;
  shell: Shell;
  start: string;
  sshHost: string;
  env: EnvVar[];
}

const EMPTY_DRAFT: Draft = { name: '', cwd: '', shell: 'pwsh', start: '', sshHost: '', env: [] };

function draftOf(session: Session): Draft {
  return {
    name: session.name,
    cwd: session.cwd,
    shell: session.shell,
    start: session.start,
    sshHost: session.sshHost,
    // 환경변수는 줄 단위로 고쳐지므로 세션의 배열과 같은 객체를 나눠 쓰면 안 된다.
    env: session.env.map((e) => ({ ...e })),
  };
}

/** 저장하지 않은 변경이 있는가. 키 순서가 `draftOf` 하나로 정해지므로 문자열 비교로 충분하다. */
function changed(session: Session, draft: Draft): boolean {
  return JSON.stringify(draftOf(session)) !== JSON.stringify(draft);
}

/**
 * 설정 화면의 입력칸.
 *
 * 값이 IPC 가 아니라 화면 안의 초안으로만 가므로 기다릴 이유가 없다 — 방금 친 글자가
 * 곧바로 초안에 들어가 있어야 이어서 누르는 저장에 함께 실린다.
 */
function DraftField(props: Omit<ComponentProps<typeof TextField>, 'debounceMs'>) {
  return <TextField debounceMs={0} {...props} />;
}

/** 세션 설정 — 일반 · 환경변수 · 종료 후 복원 요약. */
export function SettingsModal() {
  const open = useStore((s) => s.settings);
  const snapshot = useStore((s) => s.snapshot);
  const close = useStore((s) => s.closeSettings);
  const patch = useStore((s) => s.patchSession);
  const flash = useStore((s) => s.flash);
  const session = activeSession(snapshot);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // 엔터 저장은 방금 친 값까지 담아 나가야 한다. 다음 렌더를 기다릴 수 없으므로 ref 도 함께 든다.
  const draftRef = useRef(draft);
  const sessionId = session?.id ?? null;

  // 열 때 — 그리고 열어 둔 채 세션을 옮겼을 때 — 세션의 지금 값에서 다시 시작한다.
  // 스냅샷이 갱신될 때마다 다시 잡지는 않는다: 편집 중인 값을 덮어써 버린다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !session) return;
    draftRef.current = draftOf(session);
    setDraft(draftRef.current);
  }, [open, sessionId]);

  if (!open || !session) return null;

  const edit = (p: Partial<Draft>) => {
    draftRef.current = { ...draftRef.current, ...p };
    setDraft(draftRef.current);
  };
  const setEnv = (env: EnvVar[]) => edit({ env });

  const dirty = changed(session, draft);

  const save = () => {
    const d = draftRef.current;
    void patch({
      // 이름을 지운 채 저장해도 이름 없는 세션이 되지는 않는다.
      name: d.name.trim() || session.name,
      cwd: d.cwd.trim(),
      shell: d.shell,
      start: d.start,
      sshHost: d.sshHost.trim(),
      env: d.env,
    });
    close();
    flash('세션 설정 저장 · 다음에 여는 터미널부터 적용');
  };

  /** 닫기 · ✕ · 바깥 누르기 — 초안을 버린다. 세션은 손대지 않는다. */
  const cancel = () => {
    const discarded = changed(session, draftRef.current);
    close();
    if (discarded) flash('세션 설정 · 변경 사항을 저장하지 않고 닫았습니다');
  };

  const openFiles = session.panes.filter((p) => p.kind === 'md' || p.kind === 'text').length;
  const liveTerms = session.panes.filter((p) => p.kind === 'term' && p.alive).length;
  const rememberedCwds = session.panes.filter((p) => p.cwd).length;
  const runningAi = [...new Set(session.panes.map((p) => p.ai).filter(Boolean))] as AiKind[];

  const restoreRows = [
    { label: '창 배치 · 그리드', val: `${session.grid.cols}×${session.grid.rows} · ${session.panes.length} 블럭` },
    { label: '터미널 스크롤백', val: `8,192 라인 · 실행 중 ${liveTerms}` },
    { label: '열려 있던 파일', val: `${openFiles} 개` },
    {
      label: '창별 작업 폴더',
      val: rememberedCwds > 0 ? `${rememberedCwds} 개 기억` : '아직 없음',
    },
    {
      label: '실행 중이던 AI',
      val: runningAi.length > 0 ? runningAi.join(' ') : '없음',
    },
    { label: '확대 배율 · 뷰어 모드', val: '창별로 기록' },
  ];

  return (
    <div className="scrim scrim--settings" onMouseDown={cancel}>
      <div className="card settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <div
            className="settings__dot"
            style={{ background: DOT_COLORS[session.color % DOT_COLORS.length] }}
          />
          <div className="settings__title">세션 설정 · {draft.name}</div>
          <div className="spacer" />
          <div className="settings__id">{session.id}</div>
          <button className="close-x" title="닫기 · 저장하지 않음" onClick={cancel}>
            ✕
          </button>
        </div>

        <div className="settings__body">
          <section>
            <div className="settings__section-label">일반</div>
            <div className="settings__grid">
              <label className="field">
                <span className="field__label">세션 이름</span>
                <DraftField
                  value={draft.name}
                  onCommit={(name) => edit({ name })}
                  onSubmit={save}
                />
              </label>
              <label className="field field--mono">
                <span className="field__label">작업 디렉터리</span>
                <DraftField value={draft.cwd} onCommit={(cwd) => edit({ cwd })} onSubmit={save} />
              </label>
              <label className="field">
                <span className="field__label">셸</span>
                <select
                  value={draft.shell}
                  onChange={(e) => edit({ shell: e.target.value as Shell })}
                >
                  {(Object.keys(SHELL_LABELS) as Shell[]).map((s) => (
                    <option key={s} value={s}>
                      {SHELL_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              {draft.shell === 'ssh' ? (
                <label className="field field--mono">
                  <span className="field__label">SSH 호스트</span>
                  <DraftField
                    value={draft.sshHost}
                    placeholder="예: deploy@stg-01"
                    onCommit={(sshHost) => edit({ sshHost })}
                    onSubmit={save}
                  />
                </label>
              ) : (
                <label className="field field--mono">
                  <span className="field__label">시작 명령</span>
                  <DraftField
                    value={draft.start}
                    placeholder="예: cargo watch -x check"
                    onCommit={(start) => edit({ start })}
                    onSubmit={save}
                  />
                </label>
              )}
            </div>
            <div className="settings__note">
              저장한 설정은 다음에 여는 터미널부터 적용됩니다
            </div>
          </section>

          <section>
            <div className="env-head">
              <div className="settings__section-label" style={{ marginBottom: 0 }}>
                환경변수
              </div>
              <div className="spacer" />
              <button className="small-btn" onClick={() => setEnv([...draft.env, { k: '', v: '' }])}>
                ＋ 추가
              </button>
            </div>
            <div className="env-rows">
              {draft.env.map((e, i) => (
                <div className="env-row" key={i}>
                  <DraftField
                    className="env-row__key"
                    value={e.k}
                    placeholder="KEY"
                    onCommit={(k) => setEnv(draft.env.map((x, j) => (j === i ? { ...x, k } : x)))}
                    onSubmit={save}
                  />
                  <DraftField
                    className="env-row__val"
                    value={e.v}
                    placeholder="value"
                    onCommit={(v) => setEnv(draft.env.map((x, j) => (j === i ? { ...x, v } : x)))}
                    onSubmit={save}
                  />
                  <button
                    className="env-row__del"
                    title="삭제"
                    onClick={() => setEnv(draft.env.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {draft.env.length === 0 && (
                <div style={{ fontSize: 10.5, color: '#a8a49a' }}>등록된 환경변수가 없습니다</div>
              )}
            </div>
          </section>

          <section>
            <div className="settings__section-label">종료 후 복원</div>
            <div className="restore-box">
              {restoreRows.map((r) => (
                <div className="restore-row" key={r.label}>
                  <span className="restore-row__dot" />
                  <span className="restore-row__label">{r.label}</span>
                  <span className="restore-row__val">{r.val}</span>
                </div>
              ))}
            </div>
            <div className="settings__note">
              {draft.shell === 'ssh'
                ? 'SSH 세션은 원격 셸이라 작업 폴더를 기억하지 못합니다'
                : '창마다 마지막 작업 폴더와 실행 중이던 claude / codex 를 기억했다가 다시 띄웁니다'}
            </div>
          </section>
        </div>

        <div className="settings__foot">
          <div className="settings__foot-hint">
            {dirty
              ? '저장하지 않은 변경이 있습니다 · 입력칸에서 엔터를 쳐도 저장됩니다'
              : '저장을 눌러야 스냅샷에 기록됩니다'}
          </div>
          <div className="spacer" />
          <button className="ghost-btn" onClick={cancel}>
            닫기
          </button>
          <button className="primary-btn" onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
