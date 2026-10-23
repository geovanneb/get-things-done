import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  details?: unknown;
  status?: number;
  code?: string;
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) { _next(err); return; }
  // The client went away mid-request (e.g. a cancelled upload): nobody is left to answer, and it is not a server fault.
  if (req.socket?.destroyed) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} -> client disconnected: ${err.message}`);
    return;
  }
  const requestedStatus = err.statusCode ?? err.status;
  const statusCode = requestedStatus && requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;

  // Map common error patterns to HTTP status codes
  let status = statusCode;
  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 413;
  } else if (err.code?.startsWith('LIMIT_')) {
    status = 400;
  } else if (statusCode !== 500) {
    status = statusCode;
  } else if (err.message?.toLowerCase().includes('not found')) {
    status = 404;
  } else if (err.message?.toLowerCase().includes('already exists') || err.message?.toLowerCase().includes('duplicate')) {
    status = 409;
  } else if (err.message?.toLowerCase().includes('path traversal') || err.message?.toLowerCase().includes('invalid')) {
    status = 400;
  } else if (err.message?.toLowerCase().includes('not configured')) {
    status = 503;
  }

  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${status}: ${err.message}`);
  if (status === 500) {
    console.error(err.stack);
  }

  res.status(status).json({
    error: status >= 500 ? 'Internal Server Error' : err.name || 'Error',
    message: status >= 500 ? 'An unexpected server error occurred' : err.message,
    details: status >= 500 ? undefined : err.details,
  });
}
