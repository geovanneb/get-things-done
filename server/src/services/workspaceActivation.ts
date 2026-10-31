import { ScaffoldOptions } from './scaffold';
import { refreshWorkspace } from './workspaceRefresh';
import { WorkspaceService } from './workspace';
import { searchService } from './searchService';
import { watcherService } from './watcherService';
import { scheduleKaizenIntake } from './kaizenIntake';

const workspaceService = new WorkspaceService();

/**
 * Makes `workspacePath` the open workspace: creates it first when it is not one yet, then points the search
 * index and file watcher at it. Used by "Change workspace" and by the first-run setup.
 */
/** Brings the workspace's agent files up to this app (see `refreshWorkspace`). Never fails the opening. */
export async function refreshWorkspaceFiles(workspacePath: string): Promise<void> {
  try {
    const outcome = await refreshWorkspace(workspacePath);
    if (outcome.status === 'skipped') { console.log(`Workspace files not brought up to date now: ${outcome.reason}. The next opening tries again.`); return; }
    const { result } = outcome;
    const changed = [...result.added, ...result.updated, ...(result.removed ?? [])];
    if (changed.length) console.log(`Workspace files brought up to ${result.toVersion}: ${changed.join(', ')}`);
    if (result.conflicted.length) console.log(`Changed by you, so kept; the app's version is beside each as .new: ${result.conflicted.join(', ')}`);
  } catch (err) {
    console.error(`Workspace files could not be brought up to date: ${(err as Error).message}`);
  }
}

export async function activateWorkspace(
  workspacePath: string,
  init?: Partial<ScaffoldOptions>,
): Promise<{ initialized: boolean }> {
  const initialized = !workspaceService.isExistingWorkspace(workspacePath);
  if (initialized) {
    await workspaceService.initWorkspace(workspacePath, init);
  } else {
    workspaceService.setWorkspacePath(workspacePath);
    await refreshWorkspaceFiles(workspacePath);
  }
  searchService.reset();
  watcherService.start(workspacePath);
  void scheduleKaizenIntake();
  return { initialized };
}
