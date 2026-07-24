// Pure, redaction-free classification of the official Codex `codex exec --json` and
// Claude `--print --output-format stream-json` wire frames into a single ordered
// normalized representation. This is the ONE shared normalization used by both the
// production adapters (apps/server/src/providers/{codex,claude}-adapter.ts) and the
// deferred provider smoke inspector (scripts/provider-smoke.ts), eliminating parser
// drift. It performs NO redaction and NO schema validation (RunResult validation and
// sanitized-text redaction are applied by each consumer).

// Mirror of `providerEventIdentitySchema` in @orion/contracts (module-private there).
// The `normalizedAdapterEventSchema.parse` tests remain the contract-drift guard.
const PROVIDER_EVENT_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type NormalizedToolStatus = 'succeeded' | 'failed' | 'cancelled';

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheTokens?: number;
  readonly durationMs?: number;
  readonly reportedCost?: number;
  readonly currency?: string;
}

export interface NormalizedMetadata {
  readonly cliVersion?: string;
  readonly model?: string;
  readonly usage?: NormalizedUsage;
  readonly costUsd?: number;
}

export type NormalizedItem =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'output'; readonly text: string; readonly identity: string }
  | {
      readonly kind: 'tool.started';
      readonly toolId: string;
      readonly toolName: string;
      readonly sanitizedInput?: string;
      readonly identity: string;
    }
  | {
      readonly kind: 'tool.completed';
      readonly toolId: string;
      readonly toolName: string;
      readonly status: NormalizedToolStatus;
      readonly identity: string;
    }
  | { readonly kind: 'usage'; readonly usage: NormalizedUsage; readonly identity: string }
  | {
      readonly kind: 'retry';
      readonly attempt: number;
      readonly delayMs: number;
      readonly identity?: string;
    };

export type NormalizedFrame =
  | {
      readonly kind: 'recognized';
      readonly frameIdentity?: string;
      readonly items: readonly NormalizedItem[];
      readonly result?: unknown;
      readonly metadata?: NormalizedMetadata;
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid'; readonly finalSchema?: boolean };

/** Join identity parts with `:` and validate the whole composite against the identity contract. */
export function composeFrameIdentity(...parts: readonly (string | number)[]): string | undefined {
  const identity = parts.map((part) => String(part)).join(':');
  return PROVIDER_EVENT_IDENTITY.test(identity) ? identity : undefined;
}

const recognized = (frame: {
  readonly frameIdentity?: string;
  readonly items?: readonly NormalizedItem[];
  readonly result?: unknown;
  readonly metadata?: NormalizedMetadata;
}): NormalizedFrame => ({
  kind: 'recognized',
  ...(frame.frameIdentity === undefined ? {} : { frameIdentity: frame.frameIdentity }),
  items: frame.items ?? [],
  ...(frame.result === undefined ? {} : { result: frame.result }),
  ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
});

const unknownFrame: NormalizedFrame = { kind: 'unknown' };
const invalidFrame = (finalSchema = false): NormalizedFrame =>
  finalSchema ? { kind: 'invalid', finalSchema: true } : { kind: 'invalid' };

// ---------------------------------------------------------------------------
// Codex `codex exec --json` (rust-v0.145.0 exec_events.rs)
// ---------------------------------------------------------------------------
export function normalizeCodexFrame(frame: unknown): NormalizedFrame {
  if (!isRecord(frame) || typeof frame.type !== 'string') return invalidFrame();
  switch (frame.type) {
    case 'thread.started': {
      const threadId = stringValue(frame.thread_id);
      return threadId === undefined
        ? invalidFrame()
        : recognized({ items: [{ kind: 'session', sessionId: threadId }] });
    }
    case 'turn.started':
      return unknownFrame;
    case 'turn.completed': {
      const usage = codexUsage(recordValue(frame.usage));
      if (usage === undefined) return invalidFrame();
      const identity = composeFrameIdentity('turn.completed');
      if (identity === undefined) return invalidFrame();
      return recognized({
        frameIdentity: identity,
        items: [{ kind: 'usage', usage, identity }],
        metadata: { usage },
      });
    }
    case 'item.started':
      return codexItem(frame, 'item.started');
    case 'item.completed':
      return codexItem(frame, 'item.completed');
    case 'system.api_retry':
      return codexRetry(frame);
    case 'error':
    case 'turn.failed':
      return unknownFrame;
    default:
      return unknownFrame;
  }
}

function codexItem(
  frame: Record<string, unknown>,
  event: 'item.started' | 'item.completed',
): NormalizedFrame {
  const item = recordValue(frame.item);
  if (item === undefined) return invalidFrame();
  const id = stringValue(item.id);
  const itemType = stringValue(item.type);
  if (id === undefined || itemType === undefined) return invalidFrame();
  const identity = composeFrameIdentity(event, id);
  if (identity === undefined) return invalidFrame();

  if (itemType === 'agent_message') {
    if (event !== 'item.completed') return unknownFrame;
    const text = stringValue(item.text);
    if (text === undefined) return invalidFrame();
    const structured = parseJsonObject(text);
    if (structured !== undefined) {
      // Under `--output-schema` the final agent message text is the structured result.
      return recognized({ frameIdentity: identity, result: structured });
    }
    return recognized({
      frameIdentity: identity,
      items: [{ kind: 'output', text, identity }],
    });
  }

  if (itemType === 'command_execution') {
    const command = stringValue(item.command);
    if (event === 'item.started') {
      if (command === undefined) return unknownFrame;
      return recognized({
        frameIdentity: identity,
        items: [
          {
            kind: 'tool.started',
            toolId: id,
            toolName: 'command_execution',
            sanitizedInput: command,
            identity,
          },
        ],
      });
    }
    const status = codexCommandStatus(item.status);
    if (status === undefined) return invalidFrame();
    return recognized({
      frameIdentity: identity,
      items: [
        { kind: 'tool.completed', toolId: id, toolName: 'command_execution', status, identity },
      ],
    });
  }

  // reasoning, error, mcp_tool_call, web_search, todo_list, file_change, unknown ...
  return unknownFrame;
}

function codexCommandStatus(value: unknown): NormalizedToolStatus | undefined {
  if (value === 'completed') return 'succeeded';
  if (value === 'failed' || value === 'declined') return 'failed';
  if (value === 'in_progress') return undefined; // ignore an in-progress completion body
  return typeof value === 'string' ? 'succeeded' : undefined;
}

function codexUsage(usage: Record<string, unknown> | undefined): NormalizedUsage | undefined {
  if (usage === undefined) return undefined;
  const normalized = pruneUsage({
    inputTokens: nonNegativeInteger(usage.input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
    cacheTokens: nonNegativeInteger(usage.cached_input_tokens),
  });
  return normalized;
}

function codexRetry(frame: Record<string, unknown>): NormalizedFrame {
  const attempt = boundedAttempt(frame.attempt);
  const delayMs = nonNegativeInteger(frame.delay_ms);
  if (attempt === undefined || delayMs === undefined) return unknownFrame;
  return recognized({ items: [{ kind: 'retry', attempt, delayMs }] });
}

// ---------------------------------------------------------------------------
// Claude `--print --output-format stream-json` (2.1.156)
// ---------------------------------------------------------------------------
export function normalizeClaudeFrame(frame: unknown): NormalizedFrame {
  if (!isRecord(frame) || typeof frame.type !== 'string') return invalidFrame();
  switch (frame.type) {
    case 'system':
      return claudeSystem(frame);
    case 'assistant':
      return claudeAssistant(frame);
    case 'user':
      return claudeUser(frame);
    case 'result':
      return claudeResult(frame);
    default:
      return unknownFrame;
  }
}

function claudeSystem(frame: Record<string, unknown>): NormalizedFrame {
  if (frame.subtype === 'init') {
    const sessionId = stringValue(frame.session_id);
    if (sessionId === undefined) return invalidFrame();
    const model = isModelIdentifier(frame.model) ? frame.model : undefined;
    return recognized({
      items: [{ kind: 'session', sessionId }],
      ...(model === undefined ? {} : { metadata: { model } }),
    });
  }
  if (frame.subtype === 'api_retry') {
    const attempt = boundedAttempt(frame.attempt);
    const delayMs = nonNegativeInteger(frame.retry_delay_ms ?? frame.delay_ms);
    if (attempt === undefined || delayMs === undefined) return unknownFrame;
    return recognized({ items: [{ kind: 'retry', attempt, delayMs }] });
  }
  return unknownFrame;
}

function claudeAssistant(frame: Record<string, unknown>): NormalizedFrame {
  const uuid = stringValue(frame.uuid);
  const message = recordValue(frame.message);
  if (uuid === undefined || message === undefined) return invalidFrame();
  const frameIdentity = composeFrameIdentity('assistant', uuid);
  if (frameIdentity === undefined) return invalidFrame();
  const content = arrayValue(message.content);
  if (content === undefined) return invalidFrame();

  const items: NormalizedItem[] = [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) continue;
    const identity = composeFrameIdentity('assistant', uuid, index);
    if (identity === undefined) return invalidFrame();
    if (block.type === 'text') {
      const text = stringValue(block.text);
      if (text !== undefined) items.push({ kind: 'output', text, identity });
    } else if (block.type === 'tool_use') {
      const toolId = stringValue(block.id);
      const toolName = stringValue(block.name);
      if (toolId !== undefined && toolName !== undefined) {
        items.push({
          kind: 'tool.started',
          toolId,
          toolName,
          sanitizedInput: 'Provider tool input was omitted.',
          identity,
        });
      }
    }
    // Unknown/unsupported content-block types are ignored, not rejected.
  }
  return recognized({ frameIdentity, items });
}

function claudeUser(frame: Record<string, unknown>): NormalizedFrame {
  const uuid = stringValue(frame.uuid);
  const message = recordValue(frame.message);
  if (uuid === undefined || message === undefined) return invalidFrame();
  const frameIdentity = composeFrameIdentity('user', uuid);
  if (frameIdentity === undefined) return invalidFrame();
  const content = arrayValue(message.content);
  if (content === undefined) return invalidFrame();

  const items: NormalizedItem[] = [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;
    const toolId = stringValue(block.tool_use_id);
    if (toolId === undefined) continue;
    const identity = composeFrameIdentity('user', uuid, index);
    if (identity === undefined) return invalidFrame();
    items.push({
      kind: 'tool.completed',
      toolId,
      toolName: 'provider_tool',
      status: block.is_error === true ? 'failed' : 'succeeded',
      identity,
    });
  }
  return recognized({ frameIdentity, items });
}

function claudeResult(frame: Record<string, unknown>): NormalizedFrame {
  const uuid = stringValue(frame.uuid);
  if (uuid === undefined) return invalidFrame();
  const frameIdentity = composeFrameIdentity('result', uuid);
  if (frameIdentity === undefined) return invalidFrame();
  const usage = claudeUsage(frame);
  const items: NormalizedItem[] =
    usage === undefined ? [] : [{ kind: 'usage', usage, identity: frameIdentity }];
  const structured = recordValue(frame.structured_output);
  const metadata: NormalizedMetadata = {
    ...(isModelIdentifier(frame.model) ? { model: frame.model } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(isNonNegativeNumber(frame.total_cost_usd) ? { costUsd: frame.total_cost_usd } : {}),
  };
  return recognized({
    frameIdentity,
    items,
    ...(structured === undefined ? {} : { result: structured }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  });
}

function claudeUsage(frame: Record<string, unknown>): NormalizedUsage | undefined {
  const usage = recordValue(frame.usage);
  const reportedCost = isNonNegativeNumber(frame.total_cost_usd) ? frame.total_cost_usd : undefined;
  const durationMs = nonNegativeInteger(frame.duration_ms);
  const base = pruneUsage({
    inputTokens: usage === undefined ? undefined : nonNegativeInteger(usage.input_tokens),
    outputTokens: usage === undefined ? undefined : nonNegativeInteger(usage.output_tokens),
    cacheTokens:
      usage === undefined ? undefined : nonNegativeInteger(usage.cache_read_input_tokens),
    durationMs,
    ...(reportedCost === undefined ? {} : { reportedCost, currency: 'USD' }),
  });
  return base;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function pruneUsage(
  usage: Readonly<Record<string, number | string | undefined>>,
): NormalizedUsage | undefined {
  const entries = Object.entries(usage).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  const hasReportable = entries.some(([key]) => key !== 'currency');
  if (!hasReportable) return undefined;
  return Object.fromEntries(entries) as NormalizedUsage;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedAttempt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 3
    ? value
    : undefined;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}
