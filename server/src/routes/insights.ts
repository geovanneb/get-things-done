import { Router, Request, Response } from 'express';
import { InsightsService } from '../services/insightsService';
import {
  getCalendar,
  getCalendarDay,
  parseCalendarWindow,
  parseDayKey,
} from '../services/insightsCalendar';
import { param } from '../utils/params';

const router = Router();
const insightsService = new InsightsService();

/** Windows the UI offers. `all` disables the time filter. */
const ALLOWED_WINDOWS = new Set([7, 30, 90]);

function parseWindow(raw: unknown): number | null {
  if (raw === 'all') return null;
  const days = Number(raw);
  return ALLOWED_WINDOWS.has(days) ? days : 30;
}

// GET /api/insights?days=30 | 7 | 90 | all
router.get('/', async (req: Request, res: Response) => {
  try {
    const data = await insightsService.getInsightsData(parseWindow(req.query.days));
    res.json(data);
  } catch (error) {
    console.error('Failed to build insights:', error);
    res.status(500).json({ error: 'Failed to build insights' });
  }
});

// GET /api/insights/calendar?days=7 | 30 | 90 | all
// Same windows as the filter at the top of Insights, so the calendar always
// shows the period every other panel is counting.
router.get('/calendar', async (req: Request, res: Response) => {
  const days = parseCalendarWindow(req.query.days);
  if (days === undefined) {
    res.status(400).json({ error: 'Invalid window: days must be 7, 30, 90 or all' });
    return;
  }
  try {
    res.json(await getCalendar(days));
  } catch (error) {
    console.error('Failed to build the activity calendar:', error);
    res.status(500).json({ error: 'Failed to build the activity calendar' });
  }
});

// GET /api/insights/calendar/day/YYYY-MM-DD
router.get('/calendar/day/:date', async (req: Request, res: Response) => {
  const date = parseDayKey(param(req, 'date'));
  if (!date) {
    res.status(400).json({ error: 'Invalid date: use a real date as YYYY-MM-DD' });
    return;
  }
  try {
    res.json(await getCalendarDay(date));
  } catch (error) {
    console.error('Failed to build the calendar day:', error);
    res.status(500).json({ error: 'Failed to build the calendar day' });
  }
});

export default router;
