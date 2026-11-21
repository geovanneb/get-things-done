import { TaskService } from './taskService';
import { MentionService } from './mentionService';
import { syncTaskMeetings } from './meetingSources';

const taskService = new TaskService();
const mentionService = new MentionService();

/**
 * After a task is saved: pins the meetings its Objective newly mentions (see meetingSources). A meeting that cannot be
 * pinned (gone, or its review still open) is noted in the task's sources. The save itself stands either way; when the
 * pinning failed, the result says why in `meeting_sources_error`, so the task page can offer a refresh.
 */
export async function pinTaskMeetings(taskId: string): Promise<{ meeting_sources_error?: string }> {
  try {
    const saved = await taskService.getTask(taskId);
    // Read from the task as saved: what createTask returns has no Objective.
    if (saved.path) await syncTaskMeetings(saved.path, async () => mentionService.meetingIds((await taskService.getTask(taskId)).body));
    return {};
  } catch (err) {
    console.error(`[tasks] Could not pin the meetings of ${taskId}: ${(err as Error).message}`);
    return { meeting_sources_error: (err as Error).message };
  }
}
