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
import { normalizeCodexFrame } from './provider-frame-normalization.js';

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
    const toolTimers = new Map<string, ToolTimer>();
    return (frame) => buildProviderFrameMapping(normalizeCodexFrame(frame), context, toolTimers);
  }
}
