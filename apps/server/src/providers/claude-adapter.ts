import { type AgentRunRequest, type ResumeRunRequest } from '@orion/contracts';

import {
  BaseProviderAdapter,
  buildProviderFrameMapping,
  type AdapterMapperContext,
  type BuiltProviderCommand,
  type ProviderAdapterOptions,
  type ToolTimer,
} from './adapter.js';
import type { ProviderFrameMapper } from './incremental-line-parser.js';
import { normalizeClaudeFrame } from './provider-frame-normalization.js';

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
    const toolTimers = new Map<string, ToolTimer>();
    return (frame) => buildProviderFrameMapping(normalizeClaudeFrame(frame), context, toolTimers);
  }
}
