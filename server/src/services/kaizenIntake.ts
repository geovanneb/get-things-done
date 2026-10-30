import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { ContextUpdateService, KAIZEN_KIND, KAIZEN_ORIGIN } from './contextUpdateService';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { fileInside } from '../utils/files';

const workspaceService = new WorkspaceService();
const contextUpdates = new ContextUpdateService();

/** A note is a short root cause analysis; anything larger is not one. */
const MAX_NOTE_BYTES = 64 * 1024;
const MAX_FIELD = 4000;
const NOTE_NAME = /^[A-Za-z0-9][\w.-]*\.md$/;
const TASK_ID = /^TASK-\d{4}-\d{4}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FIELD) : '';
}

/** The day the note was written, when it says so clearly; otherwise the update takes today. */
function noteDay(value: unknown): string | undefined {
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(day);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : undefined;
}

/**
 * Opens a Kaizen context update for every new note an agent left in kaizen/ after a task needed rework.
 *
 * The agent writes the root cause analysis as a note (`status: proposed`); only the dashboard opens context
 * updates, so this turns each note into one: origin and kind `kaizen`, the root cause fields copied onto the
 * update, and the note itself kept as its material. The note is then marked `status: moved` with the update's id.
 * Nothing is analyzed or applied here: the user starts the analysis, reviews each file and applies.
 *
 * The update records which note it came from (`kaizen_note`), so a crash between opening the update and marking
 * the note never opens a second one: the next run finds the update and only marks the note. Applied and rejected
 * notes from before stay where they are, as history.
 *
 * Returns the ids of the updates it opened.
 */
export async function openKaizenNotes(): Promise<string[]> {
  const ws = workspaceService.getWorkspacePath();
  const dir = path.join(ws, 'kaizen');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  // Dirent.isFile() is false for a symbolic link, so a link never brings in a file from elsewhere.
  const names = entries.filter((e) => e.isFile() && NOTE_NAME.test(e.name)).map((e) => e.name).sort();
  if (names.length === 0) return [];

  const opened: string[] = [];
  let existing: Map<string, string> | null = null;
  for (const name of names) {
    try {
      const file = await fileInside(dir, name);
      if ((await fsp.stat(file)).size > MAX_NOTE_BYTES) continue;
      const raw = await fsp.readFile(file, 'utf-8');
      let parsed: { data: Record<string, unknown>; content: string };
      try {
        const { data, content } = parseMarkdown(raw);
        parsed = { data: data as Record<string, unknown>, content };
      } catch {
        console.warn(`[kaizen] ${name}: the frontmatter cannot be read, so no update was opened. Fix the note.`);
        continue;
      }
      const status = parsed.data['status'];
      if (status !== undefined && status !== null && status !== 'proposed') continue;

      existing ??= new Map((await contextUpdates.list())
        .filter((u) => u.kaizen?.note)
        .map((u) => [u.kaizen!.note, u.id]));
      let id = existing.get(name);
      if (!id) {
        const taskRef = text(parsed.data['task_ref']);
        const update = await contextUpdates.create(
          {
            title: text(parsed.data['title']) || (TASK_ID.test(taskRef) ? `Kaizen from ${taskRef}` : 'Kaizen'),
            source_date: noteDay(parsed.data['created_at']),
            text: raw,
          },
          {
            origin: KAIZEN_ORIGIN, kind: KAIZEN_KIND, textName: 'kaizen-note.md',
            fields: {
              kaizen_note: name,
              ...(TASK_ID.test(taskRef) ? { task_ref: taskRef } : {}),
              symptom: text(parsed.data['symptom']),
              root_cause: text(parsed.data['root_cause']),
              area: text(parsed.data['area']),
            },
          },
        );
        id = update.id;
        existing.set(name, id);
        opened.push(id);
      }
      await atomicWrite(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'moved', context_update: id, moved_at: new Date().toISOString() }));
    } catch (err) {
      console.warn(`[kaizen] ${name}: could not open a context update: ${(err as Error).message}`);
    }
  }
  return opened;
}

let running: Promise<void> | null = null;
let again = false;

/**
 * Runs openKaizenNotes now, or once more after the run in progress: notes are never read by two runs at once,
 * and a note written during a run is still picked up. Never throws.
 */
export function scheduleKaizenIntake(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      try { await openKaizenNotes(); } catch { /* no workspace yet: the next trigger tries again */ }
    } while (again);
  })().finally(() => { running = null; });
  return running;
}

/** Whether a watched file is a note in the workspace's kaizen/ folder (not in a subfolder). */
export function isKaizenNote(filePath: string): boolean {
  try {
    return path.dirname(filePath) === path.join(workspaceService.getWorkspacePath(), 'kaizen') && filePath.endsWith('.md');
  } catch {
    return false;
  }
}
