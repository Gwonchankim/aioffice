const sensitiveKey = /token|key|secret|password|authorization|cookie|credential/i;
const sensitiveValue = /(?:bearer\s+|-----BEGIN [A-Z ]+-----|https?:\/\/[^\s/@]+:[^\s/@]+@)/i;

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sensitiveValue.test(value) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : redactValue(nested),
      ]),
    );
  }
  return value;
}

export const pinoRedactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  '*.token',
  '*.key',
  '*.secret',
  '*.password',
  '*.authorization',
  '*.cookie',
] as const;
