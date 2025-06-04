import { z } from 'zod';

export const scanWebsiteSchema = z.object({
  url: z.preprocess(
    (val) => {
      if (
        typeof val === 'string' &&
        val.trim() !== '' &&
        !val.startsWith('http://') &&
        !val.startsWith('https://')
      ) {
        return `https://${val.trim()}`;
      }
      return val;
    },
    z.string().url({
      message: 'Invalid URL format after attempting to add https:// scheme',
    }),
  ),
});

export type ScanWebsiteInput = z.infer<typeof scanWebsiteSchema>;
