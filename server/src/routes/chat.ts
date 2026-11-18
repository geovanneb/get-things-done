import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { ChatService, type ChatStreamEvent } from '../services/chat/chatService';

const router = Router();
const service = new ChatService();
const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/chat/providers  the AI tools the chat can use: installed, signed in, models, plan usage. ?fresh=1 checks again.
router.get('/providers', async (req: Request, res: Response) => {
  res.json({ providers: await service.providers({ fresh: req.query['fresh'] === '1' }) });
});

router.get('/conversations', async (_req: Request, res: Response) => {
  res.json({ conversations: await service.list() });
});

router.post('/conversations', async (req: Request, res: Response) => {
  res.status(201).json(await service.create(body(req)));
});

router.get('/conversations/:id', async (req: Request, res: Response) => {
  res.json(await service.get(param(req, 'id')));
});

// PATCH  the tool, model or effort for the next message, or the chat's name
router.patch('/conversations/:id', async (req: Request, res: Response) => {
  res.json(await service.update(param(req, 'id'), body(req)));
});

router.delete('/conversations/:id', async (req: Request, res: Response) => {
  await service.remove(param(req, 'id'));
  res.status(204).end();
});

// POST  sends a message; answers at once, the answer arrives on the stream
router.post('/conversations/:id/messages', async (req: Request, res: Response) => {
  res.status(202).json(await service.send(param(req, 'id'), body(req)));
});

router.post('/conversations/:id/stop', async (req: Request, res: Response) => {
  res.json(await service.stop(param(req, 'id')));
});

/**
 * GET  one conversation's live stream: the whole conversation first, then the answer as it is written. The words go
 * to this stream only, never to the shared /api/events stream. A page that falls behind skips the small events; the
 * whole conversation is sent again when the answer ends, so it always ends right.
 */
router.get('/conversations/:id/stream', async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const conversation = await service.get(id);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (event: ChatStreamEvent) => {
    const small = event.type === 'text' || event.type === 'step' || event.type === 'usage';
    if (small && res.writableLength > 256 * 1024) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'deleted') res.end();
  };
  send({ type: 'conversation', conversation });
  const unsubscribe = service.subscribe(id, send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
