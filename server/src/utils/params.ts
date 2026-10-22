import { Request } from 'express';

/** A named route parameter as a string. Express 5 types every param as `string | string[]` because of wildcards. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value.join('/') : (value ?? '');
}
