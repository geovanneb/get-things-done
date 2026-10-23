import { RequestHandler } from 'express';

export function allowedOrigins(port: number): Set<string> {
  return new Set([3000, 5173, 4173, port].flatMap((p) => [
    `http://localhost:${p}`, `http://127.0.0.1:${p}`,
  ]));
}

/** Loopback binding alone does not protect against DNS rebinding or browser form posts. */
export function localRequestGuard(port: number): RequestHandler {
  const origins = allowedOrigins(port);
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!hosts.has(req.get('host') ?? '') || (origin !== undefined && !origins.has(origin)) ||
        req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Forbidden', message: 'Only trusted local requests are allowed' });
      return;
    }
    next();
  };
}
