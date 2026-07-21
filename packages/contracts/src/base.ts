import { z } from 'zod';

export const ulidSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'Expected a 26-character ULID.');

const utcIso8601Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export const utcIso8601Schema = z
  .string()
  .superRefine((value, context) => {
    const match = utcIso8601Pattern.exec(value);
    if (!match) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected a UTC ISO 8601 instant ending in Z.',
      });
      return;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a valid ISO instant.' });
      return;
    }

    const fraction = (match[7] ?? '').padEnd(3, '0');
    const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${fraction}Z`;
    if (parsed.toISOString() !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected a valid UTC calendar instant.',
      });
    }
  })
  .transform((value) => new Date(value).toISOString());

export const nonNegativeIntegerSchema = z.number().finite().int().nonnegative();
export const nonNegativeSafeIntegerSchema = nonNegativeIntegerSchema.safe();
export const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.min(1);

export const nfcStringSchema = (minimum: number, maximum: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC'))
    .pipe(z.string().min(minimum).max(maximum));

export const normalizedUniqueStringArraySchema = (
  minimumItems: number,
  maximumItems: number,
  minimumLength: number,
  maximumLength: number,
) =>
  z
    .array(nfcStringSchema(minimumLength, maximumLength))
    .min(minimumItems)
    .max(maximumItems)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Values must be unique after NFC normalization.',
            path: [index],
          });
        }
        seen.add(value);
      }
    });

export const dataClassificationSchema = z.enum([
  'public',
  'internal',
  'confidential',
  'controlled',
]);

export const projectKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{1,63}$/, 'Expected a lower-case project key slug.');

export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Expected an agent ID.');
export const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 hash.');
export const actionHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Expected a sha256 action hash.');

export const absolutePathSchema = nfcStringSchema(1, 2048).refine(
  (value) => /^(?:[A-Za-z]:[\\/]|\/)/.test(value),
  'Expected an absolute path.',
);

export type Ulid = z.infer<typeof ulidSchema>;
export type UtcIso8601 = z.infer<typeof utcIso8601Schema>;
export type DataClassification = z.infer<typeof dataClassificationSchema>;
