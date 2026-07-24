import { createHash } from 'node:crypto';

/**
 * Normalizes a SOUL.MD body for hashing and comparison: CRLF line endings are
 * collapsed to LF and the text is normalized to Unicode NFC, matching the
 * Orion Console Agent Profile Format Specification §6.
 */
export function normalizeSoulMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').normalize('NFC');
}

/**
 * Computes the SHA-256 hex digest of the normalized SOUL.MD UTF-8 bytes.
 */
export function soulSha256(markdown: string): string {
  const normalized = normalizeSoulMarkdown(markdown);
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex');
}
