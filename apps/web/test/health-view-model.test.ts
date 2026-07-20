import { canonicalM0DegradedHealth } from '@orion/contracts';
import type { HealthSuccess } from '@orion/contracts';
import { describe, expect, it } from 'vitest';

import { createHealthViewModel } from '../src/health-view-model.js';

function cloneHealth(): HealthSuccess {
  return structuredClone(canonicalM0DegradedHealth);
}

describe('createHealthViewModel', () => {
  it('maps the truthful M0 health response to Korean status labels and actual resources', () => {
    expect(createHealthViewModel(cloneHealth())).toEqual({
      overallStatus: '저하됨 (degraded)',
      databaseStatus: '초기화되지 않음',
      schedulerStatus: '초기화되지 않음',
      retentionStatus: '초기화되지 않음',
      memoryPercent: '42.5',
      freeDiskBytes: '2147483648',
    });
  });

  it('rejects healthy and unhealthy overall statuses instead of reporting them as M0 health', () => {
    const healthy = cloneHealth();
    healthy.data.status = 'healthy';
    const unhealthy = cloneHealth();
    unhealthy.data.status = 'unhealthy';

    expect(createHealthViewModel(healthy)).toBeNull();
    expect(createHealthViewModel(unhealthy)).toBeNull();
  });

  it('rejects initialized or failed subsystem states instead of reporting them as operational', () => {
    const databaseError = cloneHealth();
    databaseError.data.database = 'error';
    const schedulerOk = cloneHealth();
    schedulerOk.data.scheduler.status = 'ok';
    const retentionError = cloneHealth();
    retentionError.data.retention.status = 'error';

    expect(createHealthViewModel(databaseError)).toBeNull();
    expect(createHealthViewModel(schedulerOk)).toBeNull();
    expect(createHealthViewModel(retentionError)).toBeNull();
  });
});
