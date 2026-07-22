const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password|credential|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
] as const;

const STREAMING_TAIL_LENGTH = 256;

export function redactProviderText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted.replaceAll('\0', '').trim();
}

/** Retains sanitized diagnostics without retaining an unbounded stderr transcript. */
export class SanitizedStderrRing {
  private readonly decoder = new TextDecoder();
  private pending = '';
  private retained = '';
  private retainedBytes = 0;
  private totalBytes = 0;

  public constructor(private readonly maximumBytes = 256 * 1024) {}

  public push(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.flushSafePrefix();
  }

  public finish(): void {
    this.pending += this.decoder.decode();
    this.append(redactProviderText(this.pending));
    this.pending = '';
  }

  public get byteCount(): number {
    return this.totalBytes;
  }

  public get omittedByteCount(): number {
    return Math.max(0, this.totalBytes - this.maximumBytes);
  }

  public get text(): string {
    return this.retained;
  }

  private flushSafePrefix(): void {
    if (this.pending.length <= STREAMING_TAIL_LENGTH) return;
    const splitAt = this.pending.length - STREAMING_TAIL_LENGTH;
    this.append(redactProviderText(this.pending.slice(0, splitAt)));
    this.pending = this.pending.slice(splitAt);
  }

  private append(value: string): void {
    if (value.length === 0 || this.retainedBytes >= this.maximumBytes) return;
    const bytes = Buffer.from(value, 'utf8');
    const available = this.maximumBytes - this.retainedBytes;
    const accepted = bytes.subarray(0, available).toString('utf8');
    this.retained += accepted;
    this.retainedBytes += Buffer.byteLength(accepted, 'utf8');
  }
}
