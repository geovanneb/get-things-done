import { Router, Request, Response } from 'express';
import { AssistantAccountsService } from '../services/assistantAccounts';

/** Settings → Assistant accounts (#505): which sign-in each assistant uses, and signing in or out from the app. */
const router = Router();
const accounts = new AssistantAccountsService();
const param = (req: Request) => String(req.params['assistant']);

// GET /api/assistant-accounts  every assistant with its accounts, and the sign-in going now
router.get('/', async (_req: Request, res: Response) => {
  res.json(await accounts.list());
});

// GET /api/assistant-accounts/sign-in  the sign-in going now, or the last one
router.get('/sign-in', (_req: Request, res: Response) => {
  res.json({ sign_in: accounts.signInState() });
});

// DELETE /api/assistant-accounts/sign-in  cancel the sign-in going now
router.delete('/sign-in', async (_req: Request, res: Response) => {
  res.json({ sign_in: await accounts.cancelSignIn() });
});

// PUT /api/assistant-accounts/:assistant/choice  { folder: string | null }  the account to use from the next start
router.put('/:assistant/choice', async (req: Request, res: Response) => {
  res.json(await accounts.choose(param(req), req.body?.folder ?? null));
});

// POST /api/assistant-accounts/:assistant/accounts  { name? }  make an empty folder for another account
router.post('/:assistant/accounts', async (req: Request, res: Response) => {
  res.status(201).json(await accounts.createAccount(param(req), req.body?.name ?? null));
});

// POST /api/assistant-accounts/:assistant/folders  { path }  add an existing config folder by its path
router.post('/:assistant/folders', async (req: Request, res: Response) => {
  res.status(201).json(await accounts.addFolder(param(req), req.body?.path));
});

// DELETE /api/assistant-accounts/:assistant/folders?path=…  take an added account off the list (its folder stays)
router.delete('/:assistant/folders', async (req: Request, res: Response) => {
  res.json(await accounts.removeFolder(param(req), req.query['path']));
});

// POST /api/assistant-accounts/:assistant/sign-in  { folder, method }  start the tool's own sign-in
router.post('/:assistant/sign-in', async (req: Request, res: Response) => {
  res.status(202).json({ sign_in: await accounts.startSignIn(param(req), req.body?.folder ?? null, req.body?.method ?? null) });
});

// POST /api/assistant-accounts/:assistant/sign-out  { folder, confirm: true }  the tool's own sign-out
router.post('/:assistant/sign-out', async (req: Request, res: Response) => {
  res.json(await accounts.signOut(param(req), req.body?.folder ?? null, req.body?.confirm));
});

export default router;
