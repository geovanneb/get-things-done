import express, { Express, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { registerRoutes } from './routes';
import { localRequestGuard, allowedOrigins } from './middleware/localRequestGuard';
import { errorHandler } from './middleware/errorHandler';
import { watcherService } from './services/watcherService';
import { routineScheduler } from './services/routineScheduler';
import { WorkspaceService } from './services/workspace';
import { GitRuntime, useGitRuntime } from './services/gitService';
import { FileWatchEvent } from './types';

export const HOST = '127.0.0.1';

export interface StartServerOptions {
  /** Port on 127.0.0.1. The request guard only trusts this port, so it must be known before listening. */
  port: number;
  /** Folder of the built dashboard. Without it only the API is served. */
  uiPath?: string;
  /** Workspace to open. Without it the saved one from ~/.gtd/config.json is used. */
  workspacePath?: string;
  /** Folder of the workspace templates. Without it the copy next to the package is used. */
  templatesPath?: string;
  /** A git program to use instead of the `git` on PATH (the desktop app bundles one). */
  git?: GitRuntime;
  /** Log each request to stdout (default true). */
  logRequests?: boolean;
}

export interface RunningServer {
  port: number;
  url: string;
  /** Stops the watcher, routine checks and HTTP server. Never exits the process. */
  close(): Promise<void>;
}

/**
 * Start the API and dashboard in this process. Used by the `gtd` server entry and by hosts
 * such as a desktop shell, so both run exactly the same server.
 */
export function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { port } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error(`Invalid port: ${port}`));
  }

  // The services read these at call time, so setting them here is how options reach them.
  if (options.workspacePath) process.env['ESB_WORKSPACE_PATH'] = options.workspacePath;
  if (options.templatesPath) process.env['ESB_TEMPLATES_PATH'] = options.templatesPath;
  if (options.git) useGitRuntime(options.git);

  const sseClients = new Set<Response>();
  const app = createApp(port, options, sseClients);
  const server = http.createServer(app);

  const broadcastEvent = (event: FileWatchEvent): void => {
    const payload = JSON.stringify(event);
    for (const client of sseClients) {
      client.write(`event: file_change\ndata: ${payload}\n\n`);
    }
  };

  const close = (): Promise<void> => {
    for (const client of sseClients) {
      client.write('event: server_shutdown\ndata: {}\n\n');
      client.end();
    }
    sseClients.clear();

    watcherService.off('change', broadcastEvent);
    watcherService.off('add', broadcastEvent);
    watcherService.off('unlink', broadcastEvent);
    watcherService.stop();
    routineScheduler.stop();

    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      // Idle keep-alive connections would otherwise hold close() open.
      server.closeIdleConnections();
    });
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      const url = `http://${HOST}:${port}`;
      console.log(`Get Things Done server running at ${url}`);
      console.log(`Health check: ${url}/health`);

      // Registered unconditionally so the watcher keeps broadcasting after a workspace switch.
      watcherService.on('change', broadcastEvent);
      watcherService.on('add', broadcastEvent);
      watcherService.on('unlink', broadcastEvent);

      const workspaceService = new WorkspaceService();
      try {
        const workspacePath = workspaceService.getWorkspacePath();
        console.log(`Watching workspace: ${workspacePath}`);
        watcherService.start(workspacePath);
        // A workspace chosen with `gtd init` or `gtd use` shows up in the dashboard's switcher too.
        try { workspaceService.rememberWorkspace(workspacePath); } catch { /* the config folder is not writable: not fatal */ }
      } catch {
        console.log('Workspace not configured yet. File watcher not started.');
        console.log('Use POST /api/workspace/init to configure your workspace.');
      }

      // Runs even without a workspace yet: each tick reads the current workspace path.
      routineScheduler.start();

      resolve({ port, url, close });
    });
  });
}

function createApp(port: number, options: StartServerOptions, sseClients: Set<Response>): Express {
  const app = express();

  // Security headers. The CSP allows only what the dashboard loads: its own files, inline style attributes
  // (the UI uses inline styles), the Google Fonts stylesheet and font files, and data/blob images and downloads.
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", 'blob:'],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));

  // Reject untrusted requests before parsing bodies or running any route.
  app.use(localRequestGuard(port));
  app.use(cors({ origin: [...allowedOrigins(port)], credentials: true }));

  // Every client is this machine, so this is one shared budget. It is far above what the dashboard
  // needs and only stops a runaway local script from flooding the workspace with file operations.
  app.use(rateLimit({ windowMs: 60_000, limit: 3000, standardHeaders: 'draft-8', legacyHeaders: false }));

  if (options.logRequests !== false) app.use(morgan('dev'));

  // JSON body parser (10mb limit for markdown content)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  // Express 5 leaves req.body undefined when a request has no body; routes expect an object.
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });

  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  registerRoutes(app);

  // SSE endpoint for file change notifications
  app.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);

    const heartbeatInterval = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      sseClients.delete(res);
    });
  });

  // Unknown API paths get a JSON 404 instead of falling through to the UI's index.html
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  const { uiPath } = options;
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

  return app;
}
