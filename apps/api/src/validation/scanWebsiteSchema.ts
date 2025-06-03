import { z } from 'zod';

export const scanWebsiteSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
});

export type ScanWebsiteInput = z.infer<typeof scanWebsiteSchema>;
