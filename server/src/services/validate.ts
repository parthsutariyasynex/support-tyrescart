import type { z } from 'zod';
import { AppError } from './errors.js';

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400, 'BAD_USER_INPUT');
  return parsed.data;
}
