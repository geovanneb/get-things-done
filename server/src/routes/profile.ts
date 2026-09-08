import { Router, Request, Response } from 'express';
import { ProfileService } from '../services/profileService';

const router = Router();
const profileService = new ProfileService();

// GET /api/profile
router.get('/', async (req: Request, res: Response) => {
  const profile = await profileService.getProfile();
  res.json(profile);
});

// PUT /api/profile
router.put('/', async (req: Request, res: Response) => {
  const profile = await profileService.updateProfile(req.body);
  res.json(profile);
});

export default router;
