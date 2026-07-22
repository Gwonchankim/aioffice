import { runResultSchema, type AgentRunRequest, type ResumeRunRequest } from '@orion/contracts';

import {
  BaseProviderAdapter,
  eventMapping,
  invalidMapping,
  resultMapping,
  sessionAndStartedMapping,
  unknownMapping,
  type AdapterMapperContext,
  type BuiltProviderCommand,
  type ProviderAdapterOptions,
} from './adapter.js';
import type { ProviderFrameMapper } from './incremental-line-parser.js';
import { redactProviderText } from './provider-redaction.js';

export class CodexAdapter extends BaseProviderAdapter {
  protected readonly provider = 'openai' as const;
  protected readonly requiredCapabilities = [
    'jsonl',
    'output_schema',
    'resume',
    'sandbox',
  ] as const;

  protected readonly authenticationProbeArgs = ['login', 'status'] as const;
  public constructor(options: ProviderAdapterOptions) {
    super(options);
  }

  protected buildCommand(
    request: AgentRunRequest | ResumeRunRequest,
    schema: { readonly path: string },
    resume: boolean,
  ): BuiltProviderCommand {
    if (resume) {
      const sessionId = (request as ResumeRunRequest).sessionId;
      return {
        argv: [
          'exec',
          '--json',
          '--model',
          request.model,
          '--sandbox',
          'read-only',
          '--cd',
          request.cwd,
          '--output-schema',
          schema.path,
          'resume',
          sessionId,
          '-',
        ],
      };
    }
    return {
      argv: [
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--cd',
        request.cwd,
        '--output-schema',
        schema.path,
        '--model',
        request.model,
        '-',
      ],
    };
  }

  protected createMapper(context: AdapterMapperContext): ProviderFrameMapper {
    return (frame) => mapCodexFrame(frame, context);
  }
}

function mapCodexFrame(frame: unknown, context: AdapterMapperContext) {
  if (!isRecord(frame) || typeof frame.type !== 'string') return invalidMapping();
  switch (frame.type) {
    case 'thread.started':
      return typeof frame.thread_id === 'string'
        ? sessionAndStartedMapping(context, frame.thread_id)
        : invalidMapping();
    case 'item.started':
      return mapToolStarted(frame);
    case 'item.completed':
      return mapItemCompleted(frame);
    case 'turn.completed':
      return mapUsage(frame);
    case 'system.api_retry':
      return mapRetry(frame);
    default:
      return unknownMapping();
  }
}

function mapToolStarted(frame: Record<string, unknown>) {
  const item = recordValue(frame.item);
  const id = stringValue(frame.id);
  if (item === undefined || id === undefined) return invalidMapping();
  if (item.type !== 'command_execution' || typeof item.command !== 'string')
    return unknownMapping();
  return eventMapping(
    'run.tool.started',
    {
      toolName: 'command_execution',
      sanitizedInput: nonEmpty(redactProviderText(item.command)),
      externalMutation: false,
    },
    `item.started:${id}`,
  );
}

function mapItemCompleted(frame: Record<string, unknown>) {
  const id = stringValue(frame.id);
  if ('result' in frame) {
    if (id === undefined) return invalidMapping(true);
    const parsed = runResultSchema.safeParse(frame.result);
    return parsed.success
      ? resultMapping(parsed.data, `item.completed:${id}`)
      : invalidMapping(true);
  }
  const text = stringValue(frame.text);
  if (text !== undefined && id !== undefined) {
    return eventMapping(
      'run.output.delta',
      { channel: 'summary', text: nonEmpty(redactProviderText(text)) },
      `item.completed:${id}`,
    );
  }
  const item = recordValue(frame.item);
  if (item === undefined || id === undefined) return invalidMapping();
  if (item.type === 'agent_message') {
    const itemText = stringValue(item.text);
    return itemText === undefined
      ? invalidMapping()
      : eventMapping(
          'run.output.delta',
          { channel: 'summary', text: nonEmpty(redactProviderText(itemText)) },
          `item.completed:${id}`,
        );
  }
  if (item.type === 'command_execution') {
    const durationMs = nonNegativeInteger(item.duration_ms);
    if (durationMs === undefined) return invalidMapping();
    return eventMapping(
      'run.tool.completed',
      {
        toolName: 'command_execution',
        status:
          item.status === 'cancelled'
            ? 'cancelled'
            : item.status === 'failed'
              ? 'failed'
              : 'succeeded',
        durationMs,
      },
      `item.completed:${id}`,
    );
  }
  return unknownMapping();
}

function mapUsage(frame: Record<string, unknown>) {
  const usage = recordValue(frame.usage);
  if (usage === undefined) return invalidMapping();
  const payload = usagePayload(usage);
  return payload === undefined
    ? invalidMapping()
    : eventMapping('run.usage', payload, stringValue(frame.id));
}

function mapRetry(frame: Record<string, unknown>) {
  const attempt = positiveInteger(frame.attempt);
  const delayMs = nonNegativeInteger(frame.delay_ms);
  if (attempt === undefined || delayMs === undefined) return invalidMapping();
  return eventMapping(
    'run.retry',
    { attempt, delayMs, reasonCode: 'PROVIDER_THROTTLED' },
    stringValue(frame.id),
  );
}

function usagePayload(usage: Record<string, unknown>): Record<string, number> | undefined {
  const values = {
    inputTokens: nonNegativeInteger(usage.input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
    cacheTokens: nonNegativeInteger(usage.cache_tokens),
    durationMs: nonNegativeInteger(usage.duration_ms),
  };
  const payload = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, number>;
  return Object.keys(payload).length === 0 ? undefined : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmpty(value: string): string {
  return value.length === 0 ? '[REDACTED]' : value;
}
