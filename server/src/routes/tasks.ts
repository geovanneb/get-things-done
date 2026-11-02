import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import multer from 'multer';
import { TaskService } from '../services/taskService';
import { ExecutionPackageService } from '../services/executionPackageService';
import { TaskStatus, Priority, type Task } from '../types';
import { MentionService } from '../services/mentionService';
import { checkTaskMeetings, refreshTaskMeetings, syncTaskMeetings } from '../services/meetingSources';
import { utf8FileNames } from '../utils/uploadNames';

const upload = multer({ storage: multer.memoryStorage(), ...utf8FileNames, limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();
const taskService = new TaskService();
const executionPackageService = new ExecutionPackageService();
const mentionService = new MentionService();

/** The meetings a task's Objective mentions now, read from the task as saved (what createTask returns has no Objective). */
const mentionedMeetings = (id: string) => async () => mentionService.meetingIds((await taskService.getTask(id)).body);

/**
 * After a task is saved: pins the meetings its Objective newly mentions (see meetingSources). A meeting that cannot be
 * pinned (gone, or its review still open) is noted in the task's sources. The save itself stands either way; when the
 * pinning failed, the response says why in `meeting_sources_error`, so the task page can offer a refresh.
 */
async function pinMeetings(task: Task): Promise<{ meeting_sources_error?: string }> {
  try {
    const saved = await taskService.getTask(task.id);
    if (saved.path) await syncTaskMeetings(saved.path, mentionedMeetings(task.id));
    return {};
  } catch (err) {
    console.error(`[tasks] Could not pin the meetings of ${task.id}: ${(err as Error).message}`);
    return { meeting_sources_error: (err as Error).message };
  }
}

// GET /api/tasks
router.get('/', async (req: Request, res: Response) => {
  const { status, priority, tags, stakeholder_ref, search } = req.query;

  const filters: { status?: TaskStatus; priority?: Priority; tags?: string[]; stakeholder_ref?: string; search?: string } = {};
  if (status) filters.status = status as TaskStatus;
  if (priority) filters.priority = priority as Priority;
  if (tags) filters.tags = (tags as string).split(',');
  if (stakeholder_ref) filters.stakeholder_ref = stakeholder_ref as string;
  if (search) filters.search = search as string;

  const tasks = await taskService.listTasks(filters);
  res.json(tasks);
});

// POST /api/tasks
router.post('/', async (req: Request, res: Response) => {
  const task = await taskService.createTask(req.body);
  res.status(201).json({ ...task, ...await pinMeetings(task) });
});

// GET /api/tasks/:id
router.get('/:id', async (req: Request, res: Response) => {
  const task = await taskService.getTask(param(req, 'id'));
  res.json(task);
});

// PUT /api/tasks/:id
router.put('/:id', async (req: Request, res: Response) => {
  const task = await taskService.updateTask(param(req, 'id'), req.body);
  res.json({ ...task, ...await pinMeetings(task) });
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await taskService.deleteTask(param(req, 'id'));
  res.status(204).send();
});

// POST /api/tasks/:id/archive
router.post('/:id/archive', async (req: Request, res: Response) => {
  await taskService.archiveTask(param(req, 'id'));
  res.json({ message: `Task ${param(req, 'id')} archived` });
});

// GET /api/tasks/:id/content
router.get('/:id/content', async (req: Request, res: Response) => {
  const content = await taskService.getTaskContent(param(req, 'id'));
  res.json({ content });
});

// PUT /api/tasks/:id/content
router.put('/:id/content', async (req: Request, res: Response) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Bad Request', message: 'content must be a string' });
    return;
  }
  await taskService.updateTaskContent(param(req, 'id'), content);
  res.json({ message: 'Content updated', ...await pinMeetings(await taskService.getTask(param(req, 'id'))) });
});

// POST /api/tasks/:id/execution-package
router.post('/:id/execution-package', async (req: Request, res: Response) => {
  const options = {
    includeStakeholders: req.body.includeStakeholders ?? true,
    includeContext: req.body.includeContext ?? true,
    includeProfile: req.body.includeProfile ?? true,
    includeTemplate: req.body.includeTemplate ?? true,
    selectedContextIds: req.body.selectedContextIds,
    selectedStakeholderRefs: req.body.selectedStakeholderRefs,
  };
  const pkg = await executionPackageService.buildPackage(param(req, 'id'), options);
  const savedPath = await executionPackageService.savePackage(pkg);
  res.status(201).json({ ...pkg, saved_path: savedPath });
});

// GET /api/tasks/:id/execution-package/preview
router.get('/:id/execution-package/preview', async (req: Request, res: Response) => {
  const preview = await executionPackageService.getPackagePreview(param(req, 'id'));
  res.json(preview);
});

// GET /api/tasks/:id/meeting-sources  the meetings the task was made from, as pinned, checked against what is there now
router.get('/:id/meeting-sources', async (req: Request, res: Response) => {
  const task = await taskService.getTask(param(req, 'id'));
  if (!task.path) { res.status(404).json({ error: 'Not Found', message: 'Task file not found' }); return; }
  res.json(await checkTaskMeetings(task.path, mentionService.meetingIds(task.body)));
});

// POST /api/tasks/:id/meeting-sources/refresh  pins the mentioned meetings again, as they are now; the earlier pins stay
router.post('/:id/meeting-sources/refresh', async (req: Request, res: Response) => {
  const task = await taskService.getTask(param(req, 'id'));
  if (!task.path) { res.status(404).json({ error: 'Not Found', message: 'Task file not found' }); return; }
  res.json(await refreshTaskMeetings(task.path, mentionedMeetings(task.id)));
});

// GET /api/tasks/:id/files
router.get('/:id/files', async (req: Request, res: Response) => {
  const files = await taskService.listTaskFiles(param(req, 'id'));
  res.json(files);
});

// POST /api/tasks/:id/files
router.post('/:id/files', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }
  const saved = await taskService.saveTaskFile(param(req, 'id'), req.file.originalname, req.file.buffer);
  res.status(201).json(saved);
});

// DELETE /api/tasks/:id/files/:filename
router.delete('/:id/files/:filename', async (req: Request, res: Response) => {
  await taskService.deleteTaskFile(param(req, 'id'), param(req, 'filename'));
  res.status(204).send();
});

export default router;
