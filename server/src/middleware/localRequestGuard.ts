import { Request, RequestHandler } from 'express';

/**
 * The dashboard's own origin. The Vite and preview ports are added only outside an installed dashboard (`gtd start`
 * and the desktop app set NODE_ENV=production): there, any other program serving a page on localhost:3000 or :5173
 * would otherwise be allowed to read and change the whole workspace from the browser.
 */
export function allowedOrigins(port: number): Set<string> {
  const development = process.env['NODE_ENV'] === 'production' ? [] : [3000, 5173, 4173];
  return new Set([...development, port].flatMap((p) => [
    `http://localhost:${p}`, `http://127.0.0.1:${p}`,
  ]));
}

/** Whether a path reaches the API. Express matches routes regardless of case, so this does too; a path that cannot be
 * decoded counts as the API, so a doubtful one is refused. */
function isApiPath(rawPath: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  p = p.toLowerCase().replace(/\/{2,}/g, '/');
  return p === '/api' || p.startsWith('/api/');
}

/**
 * A top-level page load of the dashboard, from a link on another site or that tab reloaded: Chrome marks both
 * `Sec-Fetch-Site: cross-site`. It only gets the dashboard's pages and files, which read and change nothing; the page's
 * own API calls are then same-origin. Frames, scripts, fetches, form posts and every API path stay refused.
 */
function isDashboardPageLoad(req: Request): boolean {
  return (req.method === 'GET' || req.method === 'HEAD')
    && req.get('sec-fetch-mode') === 'navigate'
    && req.get('sec-fetch-dest') === 'document'
    && !isApiPath(req.path);
}

/** Loopback binding alone does not protect against DNS rebinding or browser form posts. */
export function localRequestGuard(port: number): RequestHandler {
  const origins = allowedOrigins(port);
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!hosts.has(req.get('host') ?? '') || (origin !== undefined && !origins.has(origin)) ||
        (req.get('sec-fetch-site') === 'cross-site' && !isDashboardPageLoad(req))) {
      res.status(403).json({ error: 'Forbidden', message: 'Only trusted local requests are allowed' });
      return;
    }
    next();
  };
}
