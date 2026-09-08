import { Router, Request, Response } from 'express';
import multer from 'multer';
import { OutputService } from '../services/outputService';

const router = Router();
const outputService = new OutputService();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/outputs/templates
router.get('/templates', async (req: Request, res: Response) => {
  const templates = await outputService.listTemplates();
  res.json(templates);
});

// POST /api/outputs/templates
router.post('/templates', async (req: Request, res: Response) => {
  const template = await outputService.createTemplate(req.body);
  res.status(201).json(template);
});

// GET /api/outputs/templates/:id
router.get('/templates/:id', async (req: Request, res: Response) => {
  const template = await outputService.getTemplate(req.params['id']);
  res.json(template);
});

// PUT /api/outputs/templates/:id
router.put('/templates/:id', async (req: Request, res: Response) => {
  const template = await outputService.updateTemplate(req.params['id'], req.body);
  res.json(template);
});

// DELETE /api/outputs/templates/:id
router.delete('/templates/:id', async (req: Request, res: Response) => {
  await outputService.deleteTemplate(req.params['id']);
  res.status(204).send();
});

// GET /api/outputs/templates/:id/files
router.get('/templates/:id/files', async (req: Request, res: Response) => {
  const files = await outputService.listTemplateFiles(req.params['id']);
  res.json(files);
});

// POST /api/outputs/templates/:id/files
router.post('/templates/:id/files', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }
  const saved = await outputService.saveTemplateFile(req.params['id'], req.file.originalname, req.file.buffer);
  res.status(201).json(saved);
});

// DELETE /api/outputs/templates/:id/files/:filename
router.delete('/templates/:id/files/:filename', async (req: Request, res: Response) => {
  await outputService.deleteTemplateFile(req.params['id'], req.params['filename']);
  res.status(204).send();
});

export default router;
