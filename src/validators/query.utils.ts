import { z } from 'zod';

// Transform query params from string | string[] to single values
// Express returns string | string[] for query params
const asString = z.preprocess(
  (val) => (Array.isArray(val) ? val[0] : val),
  z.string()
);

const asStringOptional = z.preprocess(
  (val) => (Array.isArray(val) ? val[0] : val),
  z.string().optional()
);

const asNumber = (opts?: { min?: number; max?: number; int?: boolean }) =>
  z.preprocess(
    (val) => (Array.isArray(val) ? val[0] : val),
    opts?.int
      ? z.coerce.number().int().min(opts.min ?? 0).max(opts.max ?? Number.MAX_SAFE_INTEGER)
      : z.coerce.number().min(opts?.min ?? 0).max(opts?.max ?? Number.MAX_SAFE_INTEGER)
  );

const asNumberOptional = (opts?: { min?: number; max?: number; int?: boolean }) =>
  z.preprocess(
    (val) => (Array.isArray(val) ? val[0] : val),
    opts?.int
      ? z.coerce.number().int().min(opts.min ?? 0).max(opts.max ?? Number.MAX_SAFE_INTEGER).optional()
      : z.coerce.number().min(opts?.min ?? 0).max(opts?.max ?? Number.MAX_SAFE_INTEGER).optional()
  );

export { asString, asStringOptional, asNumber, asNumberOptional };