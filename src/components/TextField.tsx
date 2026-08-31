import { useEffect, useRef, useState } from 'react';

/**
 * 한글 입력이 깨지지 않는 텍스트 입력.
 *
 * 값을 Rust 로 보내고 돌아온 스냅샷을 그대로 `value` 로 되먹이면, IME 조합 도중에
 * React 가 입력창 값을 덮어써서 커서가 맨 뒤로 튄다. 그래서
 *
 * 1. 화면에 보이는 값은 **로컬 상태**가 쥐고 있고 (항상 방금 친 그대로),
 * 2. 조합 중(`compositionstart` ~ `compositionend`)에는 바깥으로 아무것도 보내지 않으며,
 * 3. 바깥에서 온 값은 사용자가 편집 중이 아닐 때만 받아들인다.
 */
interface TextFieldProps {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  /** 보내기 전 기다리는 시간. 타자마다 IPC 가 나가지 않게 한다. */
  debounceMs?: number;
}

export function TextField({
  value,
  onCommit,
  placeholder,
  className,
  title,
  debounceMs = 250,
}: TextFieldProps) {
  const [local, setLocal] = useState(value);
  const composing = useRef(false);
  /** 아직 바깥에 반영되지 않은 편집이 있는가. */
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 언마운트 때 흘려보내기 위해 최신 값을 들고 있는다. */
  const latest = useRef({ local, value, onCommit });
  latest.current = { local, value, onCommit };

  // 바깥에서 바뀐 값은 편집 중이 아닐 때만 받는다 (조합 중 덮어쓰기 방지).
  useEffect(() => {
    if (composing.current || pending.current) return;
    setLocal(value);
  }, [value]);

  const flushNow = (next: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = false;
    onCommit(next);
  };

  const schedule = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pending.current = false;
      onCommit(next);
    }, debounceMs);
  };

  // 모달이 닫히는 등 갑자기 사라질 때 마지막 편집을 잃지 않는다.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const { local: l, value: v, onCommit: commit } = latest.current;
      if (pending.current && l !== v) commit(l);
    },
    [],
  );

  return (
    <input
      className={className}
      title={title}
      placeholder={placeholder}
      value={local}
      spellCheck={false}
      onChange={(e) => {
        const next = e.target.value;
        setLocal(next);
        pending.current = true;
        // 조합 중에는 중간 글자(ㅎ, 하, 한…)를 밖으로 내보내지 않는다.
        if (!composing.current) schedule(next);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        const next = e.currentTarget.value;
        setLocal(next);
        pending.current = true;
        schedule(next);
      }}
      onBlur={() => {
        if (pending.current && local !== value) flushNow(local);
      }}
    />
  );
}
