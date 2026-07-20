import { describe, expect, it } from 'vitest';

import {
  canonicalM0DegradedHealth,
  healthSuccessSchema,
  type HealthSuccess,
} from '../src/index.js';

function createPayload(): HealthSuccess {
  return structuredClone(canonicalM0DegradedHealth);
}

function omit(object: object, property: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...object };
  delete copy[property];
  return copy;
}

describe('M0 health success contract', () => {
  it('HC-001 accepts the canonical M0 degraded payload', () => {
    expect(healthSuccessSchema.parse(canonicalM0DegradedHealth)).toStrictEqual(
      canonicalM0DegradedHealth,
    );
  });

  it('HC-002 rejects payloads missing required health or envelope fields', () => {
    for (const field of ['database', 'scheduler', 'resources', 'retention'] as const) {
      const response = createPayload();
      expect(
        healthSuccessSchema.safeParse({
          ...response,
          data: omit(response.data, field),
        }).success,
      ).toBe(false);
    }

    const response = createPayload();
    expect(healthSuccessSchema.safeParse(omit(response, 'meta')).success).toBe(false);
  });

  it('HC-003 rejects invalid status values and invalid measured values', () => {
    const response = createPayload();
    const invalidPayloads = [
      {
        name: 'an invalid overall status',
        value: { ...response, data: { ...response.data, status: 'unknown' } },
      },
      {
        name: 'a negative active scheduler count',
        value: {
          ...response,
          data: { ...response.data, scheduler: { ...response.data.scheduler, active: -1 } },
        },
      },
      {
        name: 'memory above 100 percent',
        value: {
          ...response,
          data: { ...response.data, resources: { ...response.data.resources, memoryPercent: 101 } },
        },
      },
      {
        name: 'a negative memory percentage',
        value: {
          ...response,
          data: {
            ...response.data,
            resources: { ...response.data.resources, memoryPercent: -0.1 },
          },
        },
      },
      {
        name: 'negative free disk bytes',
        value: {
          ...response,
          data: { ...response.data, resources: { ...response.data.resources, freeDiskBytes: -1 } },
        },
      },
    ];

    for (const { name, value } of invalidPayloads) {
      expect(healthSuccessSchema.safeParse(value).success, name).toBe(false);
    }
  });

  it('HC-004 validates ULIDs and UTC ISO 8601 timestamps or null retention timestamps', () => {
    const response = createPayload();

    expect(
      healthSuccessSchema.safeParse({
        ...response,
        meta: { ...response.meta, requestId: 'not-a-ulid' },
      }).success,
    ).toBe(false);
    expect(
      healthSuccessSchema.safeParse({
        ...response,
        meta: { ...response.meta, timestamp: '2026-07-20T12:00:00+09:00' },
      }).success,
    ).toBe(false);
    expect(
      healthSuccessSchema.safeParse({
        ...response,
        data: {
          ...response.data,
          retention: { ...response.data.retention, lastRunAt: '2026-07-20T12:00:00+09:00' },
        },
      }).success,
    ).toBe(false);
    expect(
      healthSuccessSchema.safeParse({
        ...response,
        data: {
          ...response.data,
          retention: { ...response.data.retention, lastRunAt: null },
        },
      }).success,
    ).toBe(true);
  });

  it('HC-005 accepts a future ok-valued response without changing the health object shape', () => {
    const futureOkPayload = {
      data: {
        status: 'healthy',
        database: 'ok',
        scheduler: {
          status: 'ok',
          active: 2,
          capacity: 4,
          queued: 1,
        },
        resources: {
          memoryPercent: 37.25,
          freeDiskBytes: 4294967296,
        },
        retention: {
          lastRunAt: '2026-07-20T12:15:00.000Z',
          status: 'ok',
        },
      },
      meta: {
        requestId: '01J0M0ABCDEF1234567890ABCD',
        timestamp: '2026-07-20T12:15:00.000Z',
      },
    } satisfies HealthSuccess;

    const parsed = healthSuccessSchema.parse(futureOkPayload);

    expect(parsed).toStrictEqual(futureOkPayload);
    expect(Object.keys(parsed.data).sort()).toStrictEqual([
      'database',
      'resources',
      'retention',
      'scheduler',
      'status',
    ]);
  });
});
