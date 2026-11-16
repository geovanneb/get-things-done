import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';

const workspaceService = new WorkspaceService();

/**
 * The System cleanup settings file, read here without the System cleanup service so the context update service can
 * ask it without depending on that service. Null when it is missing or cannot be read.
 */
async function cleanupSettings(): Promise<{ meetings?: { keep_text?: unknown }; context_updates?: { keep_materials?: unknown } } | null> {
  const file = path.join(workspaceService.getWorkspacePath(), '.situation-board', 'routines', 'system-cleanup.json');
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Whether the user chose to keep meeting text after review (System cleanup > Meetings). Not chosen yet, or a file that
 * cannot be read, means no: nothing is kept that the user did not agree to keep.
 */
export async function meetingTextKept(): Promise<boolean> {
  return (await cleanupSettings())?.meetings?.keep_text === true;
}

/**
 * Whether a new context update starts with its original files kept (System cleanup > Finished context updates). Not
 * chosen, or a file that cannot be read, means no: the files go when the update is done, as before.
 */
export async function materialsKeptByDefault(): Promise<boolean> {
  return (await cleanupSettings())?.context_updates?.keep_materials === true;
}
