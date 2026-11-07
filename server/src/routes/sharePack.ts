import { Router, Request, Response } from 'express';
import { buildSharePack, previewSharePack } from '../services/sharePack';
import { sendZip } from '../utils/files';

const router = Router();

// POST /api/share-pack/preview  { items: [{ task, kind, ref }] }  the final list, a README to start from, a token
router.post('/preview', async (req: Request, res: Response) => {
  res.json(await previewSharePack(req.body));
});

// POST /api/share-pack/download  { items, readme, token }  the ZIP, only when the files are still those previewed
router.post('/download', async (req: Request, res: Response) => {
  sendZip(res, await buildSharePack(req.body));
});

export default router;
