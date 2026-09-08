import { Express } from 'express';
import tasksRouter from './tasks';
import stakeholdersRouter from './stakeholders';
import contextRouter from './context';
import outputsRouter from './outputs';
import { agentsRouter, skillsRouter } from './agents';
import profileRouter from './profile';
import workspaceRouter from './workspace';
import searchRouter from './search';
import situationRouter from './situation';
import insightsRouter from './insights';
import kaizenRouter from './kaizen';

export function registerRoutes(app: Express): void {
  app.use('/api/tasks', tasksRouter);
  app.use('/api/stakeholders', stakeholdersRouter);
  app.use('/api/context', contextRouter);
  app.use('/api/outputs', outputsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/workspace', workspaceRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/situation', situationRouter);
  app.use('/api/insights', insightsRouter);
  app.use('/api/kaizen', kaizenRouter);
}
