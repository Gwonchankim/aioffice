import type { HealthSuccess } from '../health.js';

export const canonicalM0DegradedHealth = {
  data: {
    status: 'degraded',
    database: 'not_initialized',
    scheduler: {
      status: 'not_initialized',
      active: 0,
      capacity: 0,
      queued: 0,
    },
    resources: {
      memoryPercent: 42.5,
      freeDiskBytes: 2147483648,
    },
    retention: {
      lastRunAt: null,
      status: 'not_initialized',
    },
  },
  meta: {
    requestId: '01J0M0ABCDEF1234567890ABCD',
    timestamp: '2026-07-20T12:00:00.000Z',
  },
} satisfies HealthSuccess;
