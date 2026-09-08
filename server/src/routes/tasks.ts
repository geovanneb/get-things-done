import { Router, Request, Response } from 'express';
import multer from 'multer';
import { TaskService } from '../services/taskService';
import { ExecutionPackageService } from '../services/executionPackageService';
import { TaskStatus, Priority } from '../types';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();
const taskService = new TaskService();
const executionPackageService = new ExecutionPackageService();

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
  res.status(201).json(task);
});

// GET /api/tasks/:id
router.get('/:id', async (req: Request, res: Response) => {
  const task = await taskService.getTask(req.params['id']);
  res.json(task);
});

// PUT /api/tasks/:id
router.put('/:id', async (req: Request, res: Response) => {
  const task = await taskService.updateTask(req.params['id'], req.body);
  res.json(task);
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await taskService.deleteTask(req.params['id']);
  res.status(204).send();
});

// POST /api/tasks/:id/archive
router.post('/:id/archive', async (req: Request, res: Response) => {
  await taskService.archiveTask(req.params['id']);
  res.json({ message: `Task ${req.params['id']} archived` });
});

// GET /api/tasks/:id/content
router.get('/:id/content', async (req: Request, res: Response) => {
  const content = await taskService.getTaskContent(req.params['id']);
  res.json({ content });
});

// PUT /api/tasks/:id/content
router.put('/:id/content', async (req: Request, res: Response) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Bad Request', message: 'content must be a string' });
    return;
  }
  await taskService.updateTaskContent(req.params['id'], content);
  res.json({ message: 'Content updated' });
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
  const pkg = await executionPackageService.buildPackage(req.params['id'], options);
  const savedPath = await executionPackageService.savePackage(pkg);
  res.status(201).json({ ...pkg, saved_path: savedPath });
});

// GET /api/tasks/:id/execution-package/preview
router.get('/:id/execution-package/preview', async (req: Request, res: Response) => {
  const preview = await executionPackageService.getPackagePreview(req.params['id']);
  res.json(preview);
});

// GET /api/tasks/:id/files
router.get('/:id/files', async (req: Request, res: Response) => {
  const files = await taskService.listTaskFiles(req.params['id']);
  res.json(files);
});

// POST /api/tasks/:id/files
router.post('/:id/files', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }
  const saved = await taskService.saveTaskFile(req.params['id'], req.file.originalname, req.file.buffer);
  res.status(201).json(saved);
});

// DELETE /api/tasks/:id/files/:filename
router.delete('/:id/files/:filename', async (req: Request, res: Response) => {
  await taskService.deleteTaskFile(req.params['id'], req.params['filename']);
  res.status(204).send();
});

export default router;
