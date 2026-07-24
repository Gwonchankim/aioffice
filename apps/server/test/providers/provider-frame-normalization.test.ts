import { describe, expect, it } from 'vitest';

import {
  composeFrameIdentity,
  normalizeClaudeFrame,
  normalizeCodexFrame,
  type NormalizedFrame,
} from '../../src/providers/provider-frame-normalization.js';

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function recognized(frame: NormalizedFrame) {
  if (frame.kind !== 'recognized') throw new Error(`Expected recognized, got ${frame.kind}.`);
  return frame;
}

const successResult = {
  status: 'succeeded',
  summary: 'Synthetic result.',
  findings: [],
  artifacts: [],
  changes: [],
  tests: [],
  risks: [],
  handoff: 'Done.',
};

describe('composeFrameIdentity', () => {
  it('joins regex-safe parts and rejects illegal or overlength composites', () => {
    expect(composeFrameIdentity('assistant', 'f47ac10b-58cc-4372', 0)).toBe(
      'assistant:f47ac10b-58cc-4372:0',
    );
    expect(composeFrameIdentity('item.completed', 'item_0')).toBe('item.completed:item_0');
    expect(composeFrameIdentity('assistant', 'has space')).toBeUndefined();
    expect(composeFrameIdentity('assistant', 'a#b')).toBeUndefined();
    expect(composeFrameIdentity('x', 'y'.repeat(300))).toBeUndefined();
  });
});

describe('normalizeCodexFrame', () => {
  it('maps thread.started to a session item', () => {
    const frame = recognized(
      normalizeCodexFrame({ type: 'thread.started', thread_id: 'thread-1' }),
    );
    expect(frame.items).toEqual([{ kind: 'session', sessionId: 'thread-1' }]);
  });

  it('maps a plain agent_message to an output item with a compliant identity', () => {
    const frame = recognized(
      normalizeCodexFrame({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'plain text' },
      }),
    );
    expect(frame.result).toBeUndefined();
    expect(frame.items).toHaveLength(1);
    const [item] = frame.items;
    expect(item).toMatchObject({ kind: 'output', text: 'plain text' });
    expect(item.kind === 'output' && IDENTITY.test(item.identity)).toBe(true);
    expect(frame.frameIdentity).toBe('item.completed:item_0');
  });

  it('treats a JSON agent_message as the structured result candidate, not output', () => {
    const frame = recognized(
      normalizeCodexFrame({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: JSON.stringify(successResult) },
      }),
    );
    expect(frame.items).toEqual([]);
    expect(frame.result).toMatchObject({ status: 'succeeded', handoff: 'Done.' });
  });

  it('maps command_execution start and completion, including the declined status', () => {
    const started = recognized(
      normalizeCodexFrame({
        type: 'item.started',
        item: { id: 'c1', type: 'command_execution', command: 'git status', status: 'in_progress' },
      }),
    );
    expect(started.items[0]).toMatchObject({
      kind: 'tool.started',
      toolId: 'c1',
      toolName: 'command_execution',
      sanitizedInput: 'git status',
    });
    expect(started.frameIdentity).toBe('item.started:c1');

    const completed = recognized(
      normalizeCodexFrame({
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', status: 'completed' },
      }),
    );
    expect(completed.items[0]).toMatchObject({ kind: 'tool.completed', status: 'succeeded' });
    expect(completed.frameIdentity).toBe('item.completed:c1');

    for (const [status, expected] of [
      ['failed', 'failed'],
      ['declined', 'failed'],
    ] as const) {
      const frame = recognized(
        normalizeCodexFrame({
          type: 'item.completed',
          item: { id: 'c2', type: 'command_execution', status },
        }),
      );
      expect(frame.items[0]).toMatchObject({ kind: 'tool.completed', status: expected });
    }
  });

  it('maps turn.completed usage with cached_input_tokens and a stable identity', () => {
    const frame = recognized(
      normalizeCodexFrame({
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 5 },
      }),
    );
    expect(frame.frameIdentity).toBe('turn.completed');
    expect(frame.items).toEqual([
      {
        kind: 'usage',
        usage: { inputTokens: 3, outputTokens: 5, cacheTokens: 2 },
        identity: 'turn.completed',
      },
    ]);
  });

  it('emits retry only when attempt and delay are present, else unknown', () => {
    expect(
      recognized(normalizeCodexFrame({ type: 'system.api_retry', attempt: 1, delay_ms: 100 }))
        .items[0],
    ).toMatchObject({ kind: 'retry', attempt: 1, delayMs: 100 });
    expect(normalizeCodexFrame({ type: 'system.api_retry', attempt: 1 })).toEqual({
      kind: 'unknown',
    });
  });

  it('rejects malformed frames and ignores unknown types', () => {
    expect(normalizeCodexFrame({ type: 'item.completed', item: { type: 'agent_message' } })).toEqual(
      { kind: 'invalid' },
    );
    expect(normalizeCodexFrame({ type: 'turn.started' })).toEqual({ kind: 'unknown' });
    expect(normalizeCodexFrame({ type: 'error', message: 'x' })).toEqual({ kind: 'unknown' });
    expect(normalizeCodexFrame('not-a-frame')).toEqual({ kind: 'invalid' });
    expect(
      normalizeCodexFrame({
        type: 'item.completed',
        item: { id: 'has space', type: 'agent_message', text: 'x' },
      }),
    ).toEqual({ kind: 'invalid' });
  });
});

describe('normalizeClaudeFrame', () => {
  it('maps system init to session plus model metadata', () => {
    const frame = recognized(
      normalizeClaudeFrame({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'u0',
        model: 'claude-sonnet-5',
      }),
    );
    expect(frame.items).toEqual([{ kind: 'session', sessionId: 'sess-1' }]);
    expect(frame.metadata).toEqual({ model: 'claude-sonnet-5' });
  });

  it('maps a multi-block assistant message to ordered text and tool events', () => {
    const frame = recognized(
      normalizeClaudeFrame({
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
            { type: 'thinking', thinking: 'ignored' },
          ],
        },
      }),
    );
    expect(frame.frameIdentity).toBe('assistant:a1');
    expect(frame.items.map((item) => item.kind)).toEqual(['output', 'tool.started']);
    expect(frame.items[0]).toMatchObject({ identity: 'assistant:a1:0', text: 'hello' });
    expect(frame.items[1]).toMatchObject({
      identity: 'assistant:a1:1',
      toolId: 'toolu_1',
      toolName: 'Read',
    });
    for (const item of frame.items) {
      const identity = 'identity' in item ? item.identity : undefined;
      if (identity !== undefined) expect(IDENTITY.test(identity)).toBe(true);
    }
  });

  it('maps a user tool_result to a completed tool event with error status', () => {
    const frame = recognized(
      normalizeClaudeFrame({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }] },
      }),
    );
    expect(frame.items[0]).toMatchObject({
      kind: 'tool.completed',
      toolId: 'toolu_1',
      status: 'failed',
    });
  });

  it('maps a terminal result to usage plus a structured_output candidate in one frame', () => {
    const frame = recognized(
      normalizeClaudeFrame({
        type: 'result',
        subtype: 'success',
        uuid: 'r1',
        usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 1 },
        total_cost_usd: 0.25,
        duration_ms: 1200,
        structured_output: successResult,
        result: 'ignored text',
      }),
    );
    expect(frame.frameIdentity).toBe('result:r1');
    expect(frame.result).toMatchObject({ status: 'succeeded' });
    expect(frame.items[0]).toMatchObject({
      kind: 'usage',
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        cacheTokens: 1,
        durationMs: 1200,
        reportedCost: 0.25,
        currency: 'USD',
      },
    });
  });

  it('returns the raw structured_output candidate even when it is not a valid RunResult', () => {
    const frame = recognized(
      normalizeClaudeFrame({ type: 'result', uuid: 'r2', structured_output: { status: 'bad' } }),
    );
    expect(frame.result).toEqual({ status: 'bad' });
  });

  it('maps api_retry only with a delay and rejects malformed frames', () => {
    expect(
      recognized(
        normalizeClaudeFrame({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          retry_delay_ms: 500,
        }),
      ).items[0],
    ).toMatchObject({ kind: 'retry', attempt: 2, delayMs: 500 });
    expect(
      normalizeClaudeFrame({ type: 'system', subtype: 'api_retry', attempt: 2 }),
    ).toEqual({ kind: 'unknown' });
    expect(normalizeClaudeFrame({ type: 'assistant', uuid: 'a2', message: {} })).toEqual({
      kind: 'invalid',
    });
    expect(normalizeClaudeFrame({ type: 'future' })).toEqual({ kind: 'unknown' });
  });
});
