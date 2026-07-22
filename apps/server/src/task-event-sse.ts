import type { FastifyInstance, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import { ulidSchema, type Event, type EventPayload } from '@orion/contracts';

import type { ExecutionRepository } from './repositories/execution-repository.js';
import type { RequestSecurityOptions } from './request-security.js';
import { parseSessionCookie } from './session.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_QUEUE_EVENT_LIMIT = 128;
const DEFAULT_QUEUE_BYTE_LIMIT = 256 * 1024;

export interface TaskEventBroker {
  publish(event: Event): void;
  subscribe(taskId: string, listener: (event: Event) => void): () => void;
  readonly subscriptionCount: number;
}

export class InMemoryTaskEventBroker implements TaskEventBroker {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public get subscriptionCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  public publish(event: Event): void {
    for (const listener of this.listeners.get(event.taskId) ?? []) listener(event);
  }

  public subscribe(taskId: string, listener: (event: Event) => void): () => void {
    const taskListeners = this.listeners.get(taskId) ?? new Set<(event: Event) => void>();
    taskListeners.add(listener);
    this.listeners.set(taskId, taskListeners);
    return () => {
      taskListeners.delete(listener);
      if (taskListeners.size === 0) this.listeners.delete(taskId);
    };
  }
}

export interface TaskEventSseDependencies {
  readonly security: RequestSecurityOptions;
  readonly execution: ExecutionRepository;
  readonly broker: TaskEventBroker;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly heartbeatMs?: number;
  readonly queueEventLimit?: number;
  readonly queueByteLimit?: number;
}

export function registerTaskEventSse(
  app: FastifyInstance,
  dependencies: TaskEventSseDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? ulid;
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const queueEventLimit = dependencies.queueEventLimit ?? DEFAULT_QUEUE_EVENT_LIMIT;
  const queueByteLimit = dependencies.queueByteLimit ?? DEFAULT_QUEUE_BYTE_LIMIT;

  app.get('/api/v1/tasks/:id/events/snapshot', async (request) => {
    dependencies.security.sessions.require(parseSessionCookie(request.headers.cookie));
    const taskId = parseTaskId(request.params);
    return {
      data: dependencies.execution.taskSnapshot(taskId),
      meta: { requestId: requestId(), timestamp: now().toISOString() },
    };
  });

  app.get('/api/v1/tasks/:id/events', async (request, reply) => {
    dependencies.security.sessions.require(parseSessionCookie(request.headers.cookie));
    const taskId = parseTaskId(request.params);
    const cursor = parseLastEventId(request.headers['last-event-id']);
    const bounds = dependencies.execution.taskEventBounds(taskId);
    if (!validCursor(cursor, bounds.minSequence, bounds.maxSequence)) {
      writeReset(reply, taskId);
      return reply;
    }

    const queue = new BoundedTaskEventQueue(queueEventLimit, queueByteLimit);
    let closed = false;
    let live = false;
    let blocked = false;
    let lastSequence = cursor ?? 0;
    let unsubscribe = () => {};
    const heartbeat: { value: NodeJS.Timeout | undefined } = { value: undefined };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat.value !== undefined) clearInterval(heartbeat.value);
      unsubscribe();
      queue.clear();
      request.raw.off('close', cleanup);
    };
    const write = (serialized: string): void => {
      if (closed) return;
      if (!reply.raw.write(serialized)) blocked = true;
    };
    const writeEvent = (event: Event): void => {
      if (event.taskSequence <= lastSequence) return;
      const serialized = serializeEvent(event);
      lastSequence = event.taskSequence;
      write(serialized);
    };
    const flushQueue = (): void => {
      if (closed || blocked) return;
      for (const queued of queue.drain()) {
        writeEvent(queued.event);
        if (blocked) return;
      }
    };
    const listener = (event: Event): void => {
      if (closed || event.taskSequence <= lastSequence) return;
      if (!live || blocked) {
        if (!queue.add(event, serializeEvent(event))) {
          cleanup();
          reply.raw.end();
        }
        return;
      }
      writeEvent(event);
    };

    unsubscribe = dependencies.broker.subscribe(taskId, listener);
    const highWater = dependencies.execution.taskEventBounds(taskId).maxSequence;
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();
    for (const event of dependencies.execution.taskEvents(taskId, cursor ?? 0, highWater)) {
      writeEvent(event);
    }
    for (const queued of queue.drainAfter(highWater)) writeEvent(queued.event);
    live = true;
    flushQueue();
    reply.raw.on('drain', () => {
      blocked = false;
      flushQueue();
    });
    heartbeat.value = setInterval(
      () => write(`:heartbeat ${now().toISOString()}\n\n`),
      heartbeatMs,
    );
    request.raw.once('close', cleanup);
    return reply;
  });
}

export class BoundedTaskEventQueue {
  private readonly entries: Array<{ readonly event: Event; readonly serialized: string }> = [];
  private bytes = 0;

  public constructor(
    private readonly eventLimit: number,
    private readonly byteLimit: number,
  ) {}

  public add(event: Event, serialized: string): boolean {
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (
      this.entries.length >= this.eventLimit ||
      bytes > this.byteLimit ||
      this.bytes + bytes > this.byteLimit
    ) {
      return false;
    }
    this.entries.push({ event, serialized });
    this.bytes += bytes;
    return true;
  }

  public drain(): readonly { readonly event: Event; readonly serialized: string }[] {
    const entries = this.entries.splice(0);
    this.bytes = 0;
    return entries;
  }

  public drainAfter(
    sequence: number,
  ): readonly { readonly event: Event; readonly serialized: string }[] {
    const retained = this.entries.filter((entry) => entry.event.taskSequence > sequence);
    this.entries.length = 0;
    this.bytes = 0;
    return retained;
  }

  public clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }
}

function parseTaskId(params: unknown): string {
  return ulidSchema.parse((params as { id?: unknown }).id);
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return Number.NaN;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : Number.NaN;
}

function validCursor(
  cursor: number | undefined,
  minSequence: number | null,
  highWater: number,
): boolean {
  if (cursor === undefined) return true;
  if (!Number.isSafeInteger(cursor) || cursor <= 0 || cursor > highWater) return false;
  return minSequence === null || cursor >= minSequence - 1;
}

function writeReset(reply: Pick<FastifyReply, 'raw' | 'hijack'>, taskId: string): void {
  reply.raw.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'close',
    'Content-Type': 'text/event-stream; charset=utf-8',
  });
  reply.hijack();
  reply.raw.end(
    `event: stream.reset\ndata: ${JSON.stringify({ snapshot: `/api/v1/tasks/${taskId}/events/snapshot` })}\n\n`,
  );
}

function serializeEvent(event: Event): string {
  const payload = sanitizeSsePayload(event.type, event.payload);
  const data = {
    schemaVersion: 1,
    id: event.id,
    taskId: event.taskId,
    stepId: event.stepId,
    runId: event.runId,
    provider: event.provider,
    timestamp: event.timestamp,
    payload,
  };
  return `id: ${event.taskSequence}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sanitizeSsePayload(type: Event['type'], payload: EventPayload): EventPayload {
  if (
    type === 'run.output.delta' &&
    payload.channel === 'raw' &&
    typeof payload.text === 'string'
  ) {
    return { channel: 'raw', text: '[REDACTED]' };
  }
  return payload;
}
