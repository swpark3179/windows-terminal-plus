import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { CommandPalette } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ContextMenu } from './components/ContextMenu';
import { EditToolbar } from './components/EditToolbar';
import { FilePicker } from './components/FilePicker';
import { PaneGrid } from './components/PaneGrid';
import { SessionHeader } from './components/SessionHeader';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { Toast } from './components/Toast';
import { flushSnapshot } from './ipc/bridge';
import { appOwnsKey, terminalFocused } from './lib/keys';
import { activeSession, dirtyPanes, useStore } from './state/store';

/** 크래시로 스냅샷을 통째로 잃지 않도록 주기적으로 한 번 기록한다. */
const FLUSH_INTERVAL_MS = 120_000;

export function App() {
  const ready = useStore((s) => s.ready);
  const editMode = useStore((s) => s.editMode);
  const boot = useStore((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  // ── 전역 단축키 ────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useStore.getState();
      const k = e.key.toLowerCase();

      if (e.ctrlKey && e.shiftKey && k === 'p') {
        e.preventDefault();
        store.openPalette();
        return;
      }
      if (store.palette) return;

      if (k === 'escape') {
        store.closeOverlays();
        return;
      }

      // 터미널이 포커스를 갖고 있으면 앱이 쓰겠다고 선언한 조합만 가져온다.
      if (terminalFocused() && !appOwnsKey(e)) return;
      if (!e.ctrlKey) return;

      const sel = store.sel;
      if (k === 'b') {
        e.preventDefault();
        store.toggleSidebar();
      } else if (k === 'e') {
        e.preventDefault();
        store.toggleEdit();
      } else if (k === ',') {
        e.preventDefault();
        store.openSettings();
      } else if (k === 's') {
        e.preventDefault();
        if (sel) void store.savePane(sel);
      } else if (k === '=' || k === '+') {
        e.preventDefault();
        if (sel) void store.zoomBy(sel, 1);
      } else if (k === '-') {
        e.preventDefault();
        if (sel) void store.zoomBy(sel, -1);
      } else if (k === '0') {
        e.preventDefault();
        if (sel) void store.zoomReset(sel);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── Ctrl + 휠로 창별 확대 ──────────────────────────
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      // 이미지 창은 글자 크기가 아니라 그림 배율을 스스로 조절한다.
      if (target.closest('.image-pane')) return;
      const host = target.closest('[data-pane]');
      if (!host) return;
      e.preventDefault();
      const paneId = host.getAttribute('data-pane');
      if (paneId) void useStore.getState().zoomBy(paneId, e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // ── 병합 드래그는 어디서 놓든 마무리된다 ───────────
  useEffect(() => {
    const onUp = () => {
      if (useStore.getState().dragMerge) void useStore.getState().finishMerge();
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  // ── OS 에서 끌어온 파일 ────────────────────────────
  //
  // Tauri 웹뷰는 HTML5 파일 드롭을 막아 두므로 네이티브 이벤트로 실제 경로를 받는다.
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      const store = useStore.getState();
      const payload = event.payload;

      if (payload.type === 'over') {
        store.setFileDrop(true);
        return;
      }
      if (payload.type === 'leave') {
        store.setFileDrop(false);
        return;
      }
      if (payload.type !== 'drop') return;

      store.setFileDrop(false);
      const path = payload.paths[0];
      if (!path) return;

      const session = activeSession(store.snapshot);
      if (!session) return;

      // 놓은 지점 아래의 창을 찾는다 (물리 좌표 → CSS 좌표).
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(payload.position.x / ratio, payload.position.y / ratio);
      const hostId = el instanceof Element ? el.closest('[data-pane]')?.getAttribute('data-pane') : null;
      const under = session.panes.find((p) => p.id === hostId);

      const target =
        under && under.kind === 'empty' ? under : session.panes.find((p) => p.kind === 'empty');

      if (!target) {
        store.flash('빈 블럭이 없습니다 — Ctrl+E 로 창을 분할한 뒤 놓아주세요');
        return;
      }
      void store.openFile(target.id, path);
    });

    return () => {
      void pending.then((un) => un());
    };
  }, []);

  // ── 저장하지 않은 편집이 있으면 창을 못 닫게 잡는다 ──
  useEffect(() => {
    const win = getCurrentWindow();
    const pending = win.onCloseRequested((event) => {
      const store = useStore.getState();
      const dirty = dirtyPanes(store.snapshot);
      if (dirty.length === 0) return; // 그대로 닫히게 둔다

      // 기본 닫기를 막고 물어본다. 진행하기로 하면 destroy 로 강제 종료한다.
      event.preventDefault();
      const names = dirty.map((d) => d.pane.title).join(' · ');
      store.setConfirm({
        title: '저장하지 않은 변경이 있습니다',
        message:
          dirty.length === 1
            ? `${names} 의 변경 내용을 저장하고 종료할까요?`
            : `${dirty.length}개 파일의 변경 내용을 저장하고 종료할까요?`,
        detail: dirty.length > 1 ? names : (dirty[0].pane.path ?? undefined),
        saveLabel: '저장 후 종료',
        discardLabel: '저장하지 않고 종료',
        onSave: async () => {
          await store.saveAllDirty();
          await win.destroy();
        },
        onDiscard: async () => {
          await win.destroy();
        },
      });
    });

    return () => {
      void pending.then((un) => un());
    };
  }, []);

  // ── 주기적 스냅샷 ─────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => void flushSnapshot().catch(() => {}), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  if (!ready) {
    return <div className="booting">Terminal++ · 스냅샷 여는 중…</div>;
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="body-row">
        <Sidebar />
        <div className="main">
          <SessionHeader />
          {editMode && <EditToolbar />}
          <PaneGrid />
          <StatusBar />
        </div>
      </div>

      <ContextMenu />
      <CommandPalette />
      <FilePicker />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
    </div>
  );
}
