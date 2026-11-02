import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';

const workspaceService = new WorkspaceService();

/**
 * Whether the user chose to keep meeting text after review (System cleanup > Meetings). Read here, without the System
 * cleanup service, so the context update service can ask it without depending on that service. Not chosen yet, or a
 * file that cannot be read, means no: nothing is kept that the user did not agree to keep.
 */
export async function meetingTextKept(): Promise<boolean> {
  const file = path.join(workspaceService.getWorkspacePath(), '.situation-board', 'routines', 'system-cleanup.json');
  try {
    const settings = JSON.parse(await fsp.readFile(file, 'utf-8')) as { meetings?: { keep_text?: unknown } };
    return settings?.meetings?.keep_text === true;
  } catch {
    return false;
  }
}
