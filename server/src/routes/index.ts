import { Express } from 'express';
import { WorkspaceService, withWorkspacePath } from '../services/workspace';
import tasksRouter from './tasks';
import stakeholdersRouter from './stakeholders';
import contextRouter from './context';
import contextUpdatesRouter from './contextUpdates';
import runnerRouter from './runner';
import outputsRouter from './outputs';
import { agentsRouter, skillsRouter } from './agents';
import profileRouter from './profile';
import workspaceRouter from './workspace';
import searchRouter from './search';
import situationRouter from './situation';
import insightsRouter from './insights';
import agentActivityRouter from './agentActivity';
import mentionsRouter from './mentions';
import orgChartsRouter from './orgCharts';
import routinesRouter from './routines';
import meetingQueueRouter from './meetingQueue';
import meetingsRouter from './meetings';
import transcriptionRouter from './transcription';
import voiceprintsRouter from './voiceprints';
import setupRouter from './setup';
import appRouter from './app';
import sharePackRouter from './sharePack';

export function registerRoutes(app: Express): void {
  app.use('/api', (_req, _res, next) => {
    let workspacePath: string;
    try { workspacePath = new WorkspaceService().getWorkspacePath(); }
    catch { next(); return; } // Setup routes must also work before a workspace is selected.
    withWorkspacePath(workspacePath, next);
  });
  // A page that belongs to one workspace (an update opened from a run-finished notice) says so on each request:
  // refused before anything is read or changed when another workspace is open. Checked against this request's
  // pinned workspace, the one every service below uses.
  app.use('/api', (req, res, next) => {
    const header = req.get('x-gtd-workspace');
    if (header === undefined) { next(); return; }
    let expected: string | null;
    try { expected = decodeURIComponent(header); } catch { expected = null; }
    let open: string | null;
    try { open = new WorkspaceService().getWorkspacePath(); } catch { open = null; }
    if (expected === null || expected !== open) {
      res.status(409).json({ error: 'Conflict', message: 'This update is in another workspace. Switch to it, then open the update.' });
      return;
    }
    next();
  });
  app.use('/api/tasks', tasksRouter);
  app.use('/api/stakeholders', stakeholdersRouter);
  app.use('/api/context', contextRouter);
  app.use('/api/context-updates', contextUpdatesRouter);
  app.use('/api/runner', runnerRouter);
  app.use('/api/outputs', outputsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/workspace', workspaceRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/situation', situationRouter);
  app.use('/api/insights', insightsRouter);
  app.use('/api/agent-activity', agentActivityRouter);
  app.use('/api/mentions', mentionsRouter);
  app.use('/api/org-charts', orgChartsRouter);
  app.use('/api/routines', routinesRouter);
  app.use('/api/meeting-queue', meetingQueueRouter);
  app.use('/api/meetings', meetingsRouter);
  app.use('/api/transcription', transcriptionRouter);
  app.use('/api/voiceprints', voiceprintsRouter);
  app.use('/api/app', appRouter);
  app.use('/api/share-pack', sharePackRouter);
}
