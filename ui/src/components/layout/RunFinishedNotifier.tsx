import React from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '@/utils/api';
import { desktopBridge } from '@/utils/desktop';
import { useApi } from '@/hooks/useApi';
import { RUN_FINISHED_EVENT } from '@/hooks/useLiveEvents';
import { useAppDispatch, useDataVersion } from '@/store';
import {
  anotherTabInFront, claimNotice, finishedRun, FRONT_BEAT_MS, markFront, noticeFor, noticeKey, noticeWords, runNoticesOn,
  type RunNotice, type RunRecord,
} from '@/utils/runNotices';
import type { ContextUpdate, WorkspaceConfig } from '@/types';

const inFront = () => document.visibilityState === 'visible' && document.hasFocus();
/** The workspace the server shows now: asked each time, since another tab may have switched it. */
const serverWorkspace = () => apiGet<WorkspaceConfig>('/api/workspace').then((w) => w.path, () => null);

/**
 * Tells the user a run they started from the dashboard finished, when they are elsewhere (#246): another app or tab.
 * - Heard from the server's `run-finished` event, and also found when the updates are read again (after a dropped
 *   stream too): every run seen going is read again then, so a run that ended while offline is still said.
 * - Once per run (its workspace, update and start), across this browser's tabs; never while a dashboard tab is in front.
 * - What it says is read in one request with its workspace and run, then everything else is checked again with nothing
 *   awaited before showing it (still elsewhere, still wanted).
 * - The desktop app is only told which run: it reads it from its server and writes the words, then shows it when the
 *   page's last checks pass (and its own window is not in front).
 * - A click opens the update only while the server shows the workspace it ran in.
 */
export default function RunFinishedNotifier() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const tab = React.useMemo(() => Math.random().toString(36).slice(2), []);
  const { data: updates } = useApi<ContextUpdate[]>('/api/context-updates', [useDataVersion('context-updates')]);
  /** Runs seen going: update id → workspace and start. */
  const watched = React.useRef(new Map<string, { workspace: string; started_at: string }>());
  const said = React.useRef(new Set<string>());
  /** Bumped on every mount (and the second mount of React's development check): older work stops. */
  const generation = React.useRef(0);

  React.useEffect(() => {
    // The counter itself, not a copy of its value: the cleanup must see what later work has done to it.
    const counter = generation;
    const mine = ++counter.current;
    return () => { if (counter.current === mine) counter.current++; };
  }, []);

  // This tab says when it is in front, so the others stay quiet.
  React.useEffect(() => {
    const beat = () => markFront(tab, inFront());
    beat();
    const id = setInterval(beat, FRONT_BEAT_MS);
    window.addEventListener('focus', beat);
    window.addEventListener('blur', beat);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', beat);
      window.removeEventListener('blur', beat);
      document.removeEventListener('visibilitychange', beat);
      markFront(tab, false);
    };
  }, [tab]);

  const open = React.useCallback(async (id: string, where: string) => {
    if ((await serverWorkspace()) !== where) {
      dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'warning', message: `${id} is in another workspace (${where}). Switch to it, then open the update.` } });
      return;
    }
    navigate(`/context/updates/${id}`);
  }, [navigate, dispatch]);

  React.useEffect(() => desktopBridge()?.onOpenUpdate?.((o) => void open(o.update_id, o.workspace)), [open]);

  /** Reads the update's run; says it if it ended and was seen going, or was just announced by the server. */
  const check = React.useCallback(async (id: string, announcedIn: string | null) => {
    const mine = generation.current;
    const current = () => generation.current === mine;
    const where = await serverWorkspace();
    if (!where || !current()) return;
    // An announcement from another workspace, or a run seen going in one the server no longer shows: not this one.
    if (announcedIn !== null && announcedIn !== '' && announcedIn !== where) return;
    const seen = watched.current.get(id);
    if (seen && seen.workspace !== where) { watched.current.delete(id); return; }
    const run = await apiGet<RunRecord | null>(`/api/context-updates/${id}/run`).catch(() => null);
    if (!current() || !run) return;
    if (run.status === 'running') { watched.current.set(id, { workspace: where, started_at: run.started_at }); return; }
    watched.current.delete(id);
    // A run that ended before this page knew of it is history, not news.
    if (announcedIn === null && seen?.started_at !== run.started_at) return;
    const notice = noticeFor(id, where, run, null);
    if (!notice || !current()) return;
    const key = noticeKey(notice);
    if (said.current.has(key)) return;
    // Nothing awaited between these checks and showing it: the user may have come back, turned it off, or moved on.
    const stillWanted = () => current() && runNoticesOn() && !inFront() && !anotherTabInFront(tab);
    const bridge = desktopBridge();
    const delivered = await claimNotice(key, tab, async () => {
      // The desktop app reads the run with its workspace and keeps the notice ready; after these checks, it shows it at
      // once (unless its window is in front) and answers whether it did.
      if (bridge?.prepareRunNotice && bridge.showRunNotice) {
        const token = await bridge.prepareRunNotice({ update_id: id, workspace: where, started_at: run.started_at });
        return token !== null && stillWanted() && bridge.showRunNotice(token);
      }
      if (typeof Notification === 'undefined') return false;
      // What it says, read in one request with the workspace and that very run: null when either changed.
      const query = new URLSearchParams({ workspace: where, started_at: run.started_at });
      const answer = await apiGet<{ notice: { outcome: RunNotice['outcome']; title: string; proposals: number | null } | null }>(`/api/context-updates/${id}/run-notice?${query}`).catch(() => null);
      if (!answer?.notice || !stillWanted() || Notification.permission !== 'granted') return false;
      try {
        const words = noticeWords({ ...notice, ...answer.notice });
        const note = new Notification(words.title, { body: words.body, tag: `gtd-run-${key}` });
        note.onclick = () => { window.focus(); void open(id, where); note.close(); };
        return true;
      } catch { return false; }
    });
    if (delivered) said.current.add(key);
  }, [tab, open]);

  // Announced by the server.
  React.useEffect(() => {
    const onFinished = (e: Event) => {
      const run = finishedRun((e as CustomEvent).detail);
      if (run) void check(run.update_id, run.workspace);
    };
    window.addEventListener(RUN_FINISHED_EVENT, onFinished);
    return () => window.removeEventListener(RUN_FINISHED_EVENT, onFinished);
  }, [check]);

  // The updates read again (also after a dropped stream): every run seen going is read again, whatever its update
  // shows (a failed run can leave it "analyzing"), and new ones going are watched.
  React.useEffect(() => {
    if (!updates) return;
    const ids = new Set([
      ...watched.current.keys(),
      ...updates.filter((u) => u.status === 'analyzing' || u.status === 'applying').map((u) => u.id),
    ]);
    for (const id of ids) void check(id, null);
  }, [updates, check]);

  return null;
}
