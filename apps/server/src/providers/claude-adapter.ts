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

const READ_ONLY_TOOLS = 'Read,Glob,Grep';
const DISALLOWED_TOOLS = 'Bash,Edit,Write,WebFetch,WebSearch';

export class ClaudeAdapter extends BaseProviderAdapter {
  protected readonly provider = 'anthropic' as const;
  protected readonly requiredCapabilities = [
    'stream_json',
    'output_schema',
    'resume',
    'permission_mode',
  ] as const;

  protected readonly authenticationProbeArgs = ['auth', 'status'] as const;

  public constructor(
    options: ProviderAdapterOptions,
    private readonly maximumBudgetUsd?: number,
  ) {
    super(options);
    if (
      maximumBudgetUsd !== undefined &&
      (!Number.isFinite(maximumBudgetUsd) || maximumBudgetUsd <= 0)
    ) {
      throw new Error('The maximum Claude budget must be a positive finite number.');
    }
  }

  protected buildCommand(
    request: AgentRunRequest | ResumeRunRequest,
    schema: { readonly serialized: string },
    resume: boolean,
  ): BuiltProviderCommand {
    return {
      argv: [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--json-schema',
        schema.serialized,
        '--model',
        request.model,
        '--effort',
        'low',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        READ_ONLY_TOOLS,
        '--disallowedTools',
        DISALLOWED_TOOLS,
        ...(resume ? ['--resume', (request as ResumeRunRequest).sessionId] : []),
        ...(this.maximumBudgetUsd === undefined
          ? []
          : ['--max-budget-usd', String(this.maximumBudgetUsd)]),
      ],
    };
  }

  protected createMapper(context: AdapterMapperContext): ProviderFrameMapper {
    return (frame) => mapClaudeFrame(frame, context);
  }
}

function mapClaudeFrame(frame: unknown, context: AdapterMapperContext) {
  if (!isRecord(frame) || typeof frame.type !== 'string') return invalidMapping();
  switch (frame.type) {
    case 'system':
      if (frame.subtype === 'init') {
        return typeof frame.session_id === 'string'
          ? sessionAndStartedMapping(context, frame.session_id, stringValue(frame.id))
          : invalidMapping();
      }
      if (frame.subtype === 'api_retry') return mapRetry(frame);
      return unknownMapping();
    case 'assistant':
      return mapAssistant(frame);
    case 'tool_use':
      return mapToolStarted(frame);
    case 'tool_result':
      return mapToolCompleted(frame);
    case 'result':
      return mapResult(frame);
    default:
      return unknownMapping();
  }
}

function mapAssistant(frame: Record<string, unknown>) {
  const id = stringValue(frame.id);
  const text = stringValue(frame.text);
  return id === undefined || text === undefined
    ? invalidMapping()
    : eventMapping(
        'run.output.delta',
        { channel: 'summary', text: nonEmpty(redactProviderText(text)) },
        `assistant:${id}`,
      );
}

function mapToolStarted(frame: Record<string, unknown>) {
  const id = stringValue(frame.id);
  const name = stringValue(frame.name);
  if (id === undefined || name === undefined) return invalidMapping();
  return eventMapping(
    'run.tool.started',
    { toolName: name, sanitizedInput: 'Provider tool input was omitted.', externalMutation: false },
    `tool_use:${id}`,
  );
}

function mapToolCompleted(frame: Record<string, unknown>) {
  const id = stringValue(frame.id);
  const durationMs = nonNegativeInteger(frame.duration_ms);
  if (id === undefined || durationMs === undefined) return invalidMapping();
  return eventMapping(
    'run.tool.completed',
    {
      toolName: 'provider_tool',
      status:
        frame.status === 'cancelled'
          ? 'cancelled'
          : frame.status === 'failed'
            ? 'failed'
            : 'succeeded',
      durationMs,
    },
    `tool_result:${id}`,
  );
}

function mapResult(frame: Record<string, unknown>) {
  const id = stringValue(frame.id);
  if ('result' in frame) {
    const parsed = runResultSchema.safeParse(frame.result);
    return parsed.success
      ? resultMapping(parsed.data, id === undefined ? undefined : `result:${id}`)
      : invalidMapping(true);
  }
  const usage = recordValue(frame.usage);
  if (usage === undefined) return invalidMapping();
  const payload = usagePayload(usage);
  return payload === undefined
    ? invalidMapping()
    : eventMapping('run.usage', payload, id === undefined ? undefined : `result:${id}`);
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
