import { activeSession, useStore } from '../state/store';
import { DOT_COLORS, SHELL_LABELS, type EnvVar, type Shell } from '../state/types';
import { TextField } from './TextField';

/** 세션 설정 — 일반 · AI 세션 ID · 환경변수 · 종료 후 복원 요약. */
export function SettingsModal() {
  const open = useStore((s) => s.settings);
  const snapshot = useStore((s) => s.snapshot);
  const close = useStore((s) => s.closeSettings);
  const patch = useStore((s) => s.patchSession);
  const session = activeSession(snapshot);

  if (!open || !session) return null;

  const setEnv = (env: EnvVar[]) => void patch({ env });

  const openFiles = session.panes.filter((p) => p.kind === 'md' || p.kind === 'text').length;
  const liveTerms = session.panes.filter((p) => p.kind === 'term' && p.alive).length;

  const restoreRows = [
    { label: '창 배치 · 그리드', val: `${session.grid.cols}×${session.grid.rows} · ${session.panes.length} 블럭` },
    { label: '터미널 스크롤백', val: `8,192 라인 · 실행 중 ${liveTerms}` },
    { label: '열려 있던 파일', val: `${openFiles} 개` },
    {
      label: 'AI 세션 ID',
      val: [session.claude ? 'claude' : '', session.codex ? 'codex' : ''].filter(Boolean).join(' ') || '없음',
    },
    { label: '확대 배율 · 뷰어 모드', val: '창별로 기록' },
  ];

  return (
    <div className="scrim scrim--settings" onMouseDown={close}>
      <div className="card settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <div
            className="settings__dot"
            style={{ background: DOT_COLORS[session.color % DOT_COLORS.length] }}
          />
          <div className="settings__title">세션 설정 · {session.name}</div>
          <div className="spacer" />
          <div className="settings__id">{session.id}</div>
          <button className="close-x" onClick={close}>
            ✕
          </button>
        </div>

        <div className="settings__body">
          <section>
            <div className="settings__section-label">일반</div>
            <div className="settings__grid">
              <label className="field">
                <span className="field__label">세션 이름</span>
                <TextField value={session.name} onCommit={(name) => void patch({ name })} />
              </label>
              <label className="field field--mono">
                <span className="field__label">작업 디렉터리</span>
                <TextField value={session.cwd} onCommit={(cwd) => void patch({ cwd })} />
              </label>
              <label className="field">
                <span className="field__label">셸</span>
                <select
                  value={session.shell}
                  onChange={(e) => void patch({ shell: e.target.value as Shell })}
                >
                  {(Object.keys(SHELL_LABELS) as Shell[]).map((s) => (
                    <option key={s} value={s}>
                      {SHELL_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              {session.shell === 'ssh' ? (
                <label className="field field--mono">
                  <span className="field__label">SSH 호스트</span>
                  <TextField
                    value={session.sshHost}
                    placeholder="예: deploy@stg-01"
                    onCommit={(sshHost) => void patch({ sshHost })}
                  />
                </label>
              ) : (
                <label className="field field--mono">
                  <span className="field__label">시작 명령</span>
                  <TextField
                    value={session.start}
                    placeholder="예: cargo watch -x check"
                    onCommit={(start) => void patch({ start })}
                  />
                </label>
              )}
            </div>
            <div className="settings__note">
              설정은 다음에 여는 터미널부터 적용됩니다
            </div>
          </section>

          <section>
            <div className="settings__section-label">AI 세션</div>
            <div className="settings__grid">
              <label className="field field--claude">
                <span className="field__label">Claude 세션 ID</span>
                <TextField
                  value={session.claude}
                  placeholder="sess_..."
                  onCommit={(claude) => void patch({ claude })}
                />
              </label>
              <label className="field field--codex">
                <span className="field__label">Codex 세션 ID</span>
                <TextField
                  value={session.codex}
                  placeholder="cx_..."
                  onCommit={(codex) => void patch({ codex })}
                />
              </label>
            </div>
            <div className="settings__note">
              세션 헤더의 claude / codex 칩을 누르면 이 ID 로 resume 명령을 실행합니다
            </div>
          </section>

          <section>
            <div className="env-head">
              <div className="settings__section-label" style={{ marginBottom: 0 }}>
                환경변수
              </div>
              <div className="spacer" />
              <button
                className="small-btn"
                onClick={() => setEnv([...session.env, { k: '', v: '' }])}
              >
                ＋ 추가
              </button>
            </div>
            <div className="env-rows">
              {session.env.map((e, i) => (
                <div className="env-row" key={i}>
                  <TextField
                    className="env-row__key"
                    value={e.k}
                    placeholder="KEY"
                    onCommit={(k) => setEnv(session.env.map((x, j) => (j === i ? { ...x, k } : x)))}
                  />
                  <TextField
                    className="env-row__val"
                    value={e.v}
                    placeholder="value"
                    onCommit={(v) => setEnv(session.env.map((x, j) => (j === i ? { ...x, v } : x)))}
                  />
                  <button
                    className="env-row__del"
                    title="삭제"
                    onClick={() => setEnv(session.env.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {session.env.length === 0 && (
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
          </section>
        </div>

        <div className="settings__foot">
          <div className="settings__foot-hint">변경 사항은 즉시 스냅샷에 기록됩니다</div>
          <div className="spacer" />
          <button className="primary-btn" onClick={close}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
