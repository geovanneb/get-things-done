import { Router, Request, Response } from 'express';
import { deviceInbox } from '../services/deviceInbox';

const router = Router();

// GET /api/devices  whether the inbox is on, and the paired phones
router.get('/', async (_req: Request, res: Response) => {
  res.json(await deviceInbox.status());
});

// PUT /api/devices/enabled  { enabled: boolean }  start or stop listening on the local network
router.put('/enabled', async (req: Request, res: Response) => {
  const enabled = (req.body as { enabled?: unknown }).enabled;
  if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be true or false' }); return; }
  res.json(await deviceInbox.setEnabled(enabled));
});

// POST /api/devices/pairing  a code to show as a QR. It works once, for five minutes.
router.post('/pairing', async (_req: Request, res: Response) => {
  res.status(201).json(await deviceInbox.startPairing());
});

router.delete('/pairing', (_req: Request, res: Response) => {
  deviceInbox.cancelPairing();
  res.status(204).end();
});

// DELETE /api/devices/:id  forget a phone. It can no longer send anything.
router.delete('/:id', async (req: Request, res: Response) => {
  res.json(await deviceInbox.removeDevice(String(req.params['id'])));
});

export default router;
