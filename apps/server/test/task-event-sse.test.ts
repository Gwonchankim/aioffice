import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { Event } from '@orion/contracts';

import { SessionManager } from '../src/session.js';
import {
  BoundedTaskEventQueue,
  InMemoryTaskEventBroker,
  registerTaskEventSse,
} from '../src/task-event-sse.js';

function event(taskId: string, sequence: number): Event {
  return {
    id: ulid(),
    taskId,
    stepId: null,
    runId: null,
    provider: 'system',
    type: 'task.status',
    timestamp: '2026-07-22T00:00:00.000Z',
    payload: { status: 'running' },
    taskSequence: sequence,
    runSequence: null,
  };
}

describe('task event SSE', () => {
  it('SSE-001 authenticates events and snapshots before parsing, querying, subscribing, or allocating', async () => {
    const app = Fastify();
    const sessions = new SessionManager(
      () => new Date('2026-07-22T00:00:00.000Z'),
      60_000,
      'bootstrap',
    );
    const broker = new InMemoryTaskEventBroker();
    let queries = 0;
    registerTaskEventSse(app, {
      security: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', sessions },
      broker,
      execution: {
        taskEventBounds: () => {
          queries += 1;
          return { minSequence: 1, maxSequence: 1 };
        },
        taskEvents: () => [],
        taskSnapshot: (taskId: string) => {
          queries += 1;
          return { taskId, status: 'running', highWaterSequence: 1, runs: [] };
        },
      } as never,
    });
    const taskId = ulid();
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}/events` })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/tasks/not-a-task/events/snapshot` }))
        .statusCode,
    ).toBe(401);
    expect([queries, broker.subscriptionCount]).toEqual([0, 0]);
    const session = sessions.bootstrap('bootstrap');
    const reset = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/events`,
      headers: { cookie: `orion_session=${session.cookie}`, 'last-event-id': 'not-a-sequence' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.body).toContain('event: stream.reset');
    expect(reset.body).toContain(`/api/v1/tasks/${taskId}/events/snapshot`);
    expect([queries, broker.subscriptionCount]).toEqual([1, 0]);
    const snapshot = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/events/snapshot`,
      headers: { cookie: `orion_session=${session.cookie}` },
    });
    expect(snapshot.json().data).toEqual({
      taskId,
      status: 'running',
      highWaterSequence: 1,
      runs: [],
    });
    await app.close();
  });

  it('SSE-002 keeps bounded queues ordered and drops slow consumers instead of retaining unbounded events', () => {
    const taskId = ulid();
    const queue = new BoundedTaskEventQueue(2, 1024);
    expect(queue.add(event(taskId, 1), 'one')).toBe(true);
    expect(queue.add(event(taskId, 2), 'two')).toBe(true);
    expect(queue.add(event(taskId, 3), 'three')).toBe(false);
    expect(queue.drainAfter(1).map((entry) => entry.event.taskSequence)).toEqual([2]);
    expect(queue.drain()).toEqual([]);
  });

  it('SSE-003 publishes live events only to the matching task and releases disconnect subscriptions', () => {
    const broker = new InMemoryTaskEventBroker();
    const taskId = ulid();
    const received: number[] = [];
    const unsubscribe = broker.subscribe(taskId, (value) => received.push(value.taskSequence));
    broker.publish(event(taskId, 1));
    broker.publish(event(ulid(), 1));
    expect(received).toEqual([1]);
    unsubscribe();
    expect(broker.subscriptionCount).toBe(0);
  });
  it('SSE-004 replays through high-water then delivers one live event and heartbeat without exposing raw output', async () => {
    const app = Fastify();
    const sessions = new SessionManager(
      () => new Date('2026-07-22T00:00:00.000Z'),
      60_000,
      'bootstrap',
    );
    const session = sessions.bootstrap('bootstrap');
    const broker = new InMemoryTaskEventBroker();
    const taskId = ulid();
    const replay = {
      ...event(taskId, 1),
      type: 'run.output.delta' as const,
      payload: { channel: 'raw', text: 'Bearer never-send-this' },
    };
    registerTaskEventSse(app, {
      security: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', sessions },
      broker,
      heartbeatMs: 5,
      execution: {
        taskEventBounds: () => ({ minSequence: 1, maxSequence: 1 }),
        taskEvents: () => [replay],
        taskSnapshot: () => ({ taskId, status: 'running', highWaterSequence: 1, runs: [] }),
      } as never,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const streamed = await new Promise<string>((resolve, reject) => {
      const request = get(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: `/api/v1/tasks/${taskId}/events`,
          headers: { cookie: `orion_session=${session.cookie}` },
        },
        (response) => {
          let output = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            output += chunk;
            if (output.includes('id: 1') && !output.includes('id: 2')) {
              broker.publish(event(taskId, 2));
            }
            if (output.includes('id: 2') && output.includes(':heartbeat')) {
              request.destroy();
              resolve(output);
            }
          });
          response.on('error', reject);
        },
      );
      request.setTimeout(1_000, () => {
        request.destroy();
        reject(new Error('SSE stream did not replay and hand off in time.'));
      });
      request.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });
    expect(streamed.match(/^id: [12]$/gm)).toEqual(['id: 1', 'id: 2']);
    expect(streamed).toContain('[REDACTED]');
    expect(streamed).not.toContain('never-send-this');
    await app.close();
  });
});
