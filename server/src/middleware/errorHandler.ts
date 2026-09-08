import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  details?: unknown;
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode || 500;

  // Map common error patterns to HTTP status codes
  let status = statusCode;
  if (err.message?.toLowerCase().includes('not found')) {
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
    message: err.message,
    details: err.details,
  });
}
