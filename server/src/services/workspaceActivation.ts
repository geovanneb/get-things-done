import { ScaffoldOptions } from './scaffold';
import { WorkspaceService } from './workspace';
import { searchService } from './searchService';
import { watcherService } from './watcherService';
import { scheduleKaizenIntake } from './kaizenIntake';

const workspaceService = new WorkspaceService();

/**
 * Makes `workspacePath` the open workspace: creates it first when it is not one yet, then points the search
 * index and file watcher at it. Used by "Change workspace" and by the first-run setup.
 */
export async function activateWorkspace(
  workspacePath: string,
  init?: Partial<ScaffoldOptions>,
): Promise<{ initialized: boolean }> {
  const initialized = !workspaceService.isExistingWorkspace(workspacePath);
  if (initialized) {
    await workspaceService.initWorkspace(workspacePath, init);
  } else {
    workspaceService.setWorkspacePath(workspacePath);
  }
  searchService.reset();
  watcherService.start(workspacePath);
  void scheduleKaizenIntake();
  return { initialized };
}
