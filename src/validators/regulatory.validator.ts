import { z } from 'zod';

export const acceptRegulatoryTermsSchema = z.object({
  version: z.string().optional(),
});

export type AcceptRegulatoryTermsInput = z.infer<typeof acceptRegulatoryTermsSchema>;
