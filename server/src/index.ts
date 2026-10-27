import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { registerRoutes } from './routes';
import { localRequestGuard, allowedOrigins } from './middleware/localRequestGuard';
import { errorHandler } from './middleware/errorHandler';
import { watcherService } from './services/watcherService';
import { routineScheduler } from './services/routineScheduler';
import { WorkspaceService } from './services/workspace';
import { FileWatchEvent } from './types';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env['PORT'] || '3001', 10);

const app = express();

// Security headers
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

// Reject untrusted requests before parsing bodies or running any route.
app.use(localRequestGuard(PORT));
app.use(cors({ origin: [...allowedOrigins(PORT)], credentials: true }));

// Request logging
app.use(morgan('dev'));

// JSON body parser (10mb limit for markdown content)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Express 5 leaves req.body undefined when a request has no body; routes expect an object.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// All API routes
registerRoutes(app);

// SSE endpoint for file change notifications
const sseClients = new Set<Response>();

app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

  sseClients.add(res);

  // Heartbeat to keep connection alive
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeatInterval);
    sseClients.delete(res);
  });
});

function broadcastEvent(event: FileWatchEvent): void {
  const payload = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`event: file_change\ndata: ${payload}\n\n`);
  }
}

// Unknown API paths get a JSON 404 instead of falling through to the UI's index.html
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve pre-built UI in production mode
const uiPath = process.env['ESB_UI_PATH'];
if (uiPath && fs.existsSync(uiPath)) {
  app.use(express.static(uiPath));
  app.get('/{*splat}', (req: Request, res: Response) => {
    const indexPath = path.join(uiPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      // A global install often lives under a dot-folder (~/.nvm/...), which Express 5 refuses by default.
      res.sendFile(indexPath, { dotfiles: 'allow' });
    } else {
      res.status(404).json({ error: 'UI not found' });
    }
  });
}

// Error handler (must be last middleware)
app.use(errorHandler);

// Start server
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  console.log(`ESB server running at http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);

  // Registered unconditionally so the watcher keeps broadcasting after a workspace switch.
  watcherService.on('change', broadcastEvent);
  watcherService.on('add', broadcastEvent);
  watcherService.on('unlink', broadcastEvent);

  const workspaceService = new WorkspaceService();
  try {
    const workspacePath = workspaceService.getWorkspacePath();
    console.log(`Watching workspace: ${workspacePath}`);
    watcherService.start(workspacePath);
  } catch {
    console.log('Workspace not configured yet. File watcher not started.');
    console.log('Use POST /api/workspace/init to configure your workspace.');
  }

  // Runs even without a workspace yet: each tick reads the current workspace path.
  routineScheduler.start();
});

// Graceful shutdown
const shutdown = (): void => {
  console.log('\nShutting down server...');

  // Close SSE connections
  for (const client of sseClients) {
    client.write('event: server_shutdown\ndata: {}\n\n');
    client.end();
  }
  sseClients.clear();

  // Stop file watcher and routine checks
  watcherService.stop();
  routineScheduler.stop();

  server.close((err) => {
    if (err) {
      console.error('Error during server shutdown:', err);
      process.exit(1);
    }
    console.log('Server stopped.');
    process.exit(0);
  });

  // Force exit after 10s if graceful shutdown fails
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
