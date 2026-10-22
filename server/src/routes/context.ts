import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import multer from 'multer';
import { ContextService } from '../services/contextService';
import { sendFile, sendZip } from '../utils/files';
import { ContextCategory } from '../types';

const router = Router();
const contextService = new ContextService();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/context
router.get('/', async (req: Request, res: Response) => {
  const category = req.query['category'] as ContextCategory | undefined;
  const notes = await contextService.listContextNotes(category);
  res.json(notes);
});

// POST /api/context
router.post('/', async (req: Request, res: Response) => {
  const note = await contextService.createContextNote(req.body);
  res.status(201).json(note);
});

// GET /api/context/:id
router.get('/:id', async (req: Request, res: Response) => {
  const note = await contextService.getContextNote(param(req, 'id'));
  res.json(note);
});

// PUT /api/context/:id
router.put('/:id', async (req: Request, res: Response) => {
  const note = await contextService.updateContextNote(param(req, 'id'), req.body);
  res.json(note);
});

// DELETE /api/context/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await contextService.deleteContextNote(param(req, 'id'));
  res.status(204).send();
});

// GET /api/context/:id/files
router.get('/:id/files', async (req: Request, res: Response) => {
  const files = await contextService.listContextFiles(param(req, 'id'));
  res.json(files);
});

// POST /api/context/:id/files
router.post('/:id/files', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }
  const saved = await contextService.saveContextFile(param(req, 'id'), req.file.originalname, req.file.buffer);
  res.status(201).json(saved);
});

// GET /api/context/:id/archive — the note's folder (note.md and attachments) as <folder>.zip
router.get('/:id/archive', async (req: Request, res: Response) => {
  sendZip(res, await contextService.contextArchive(param(req, 'id')));
});

// GET /api/context/:id/files/<path> — open in the browser; ?download=1 to save it. The path may include subfolders.
router.get('/:id/files/*filename', async (req: Request, res: Response) => {
  const fullPath = await contextService.contextFilePath(param(req, 'id'), param(req, 'filename'));
  sendFile(res, fullPath, req.query['download'] === '1');
});

// DELETE /api/context/:id/files/:filename
router.delete('/:id/files/:filename', async (req: Request, res: Response) => {
  await contextService.deleteContextFile(param(req, 'id'), param(req, 'filename'));
  res.status(204).send();
});

export default router;
