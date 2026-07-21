import { canonicalM0DegradedHealth } from '@orion/contracts';
import type { HealthSuccess } from '@orion/contracts';
import { describe, expect, it } from 'vitest';

import { createHealthViewModel } from '../src/health-view-model.js';

function cloneHealth(): HealthSuccess {
  return structuredClone(canonicalM0DegradedHealth);
}

describe('createHealthViewModel', () => {
  it('maps the truthful M0 degraded health response to Korean status labels and actual resources', () => {
    expect(createHealthViewModel(cloneHealth())).toEqual({
      overallStatus: '저하됨 (degraded)',
      databaseStatus: '초기화되지 않음',
      schedulerStatus: '초기화되지 않음',
      retentionStatus: '초기화되지 않음',
      memoryPercent: '42.5',
      freeDiskBytes: '2147483648',
    });
  });

  it('maps initialized M1 database health without claiming scheduler or retention initialization', () => {
    const initialized = cloneHealth();
    initialized.data.status = 'healthy';
    initialized.data.database = 'ok';

    expect(createHealthViewModel(initialized)).toEqual({
      overallStatus: '정상 (healthy)',
      databaseStatus: '정상 (ok)',
      schedulerStatus: '초기화되지 않음',
      retentionStatus: '초기화되지 않음',
      memoryPercent: '42.5',
      freeDiskBytes: '2147483648',
    });
  });

  it('maps an unhealthy database status truthfully', () => {
    const unhealthy = cloneHealth();
    unhealthy.data.status = 'unhealthy';
    unhealthy.data.database = 'error';

    expect(createHealthViewModel(unhealthy)).toMatchObject({
      overallStatus: '비정상 (unhealthy)',
      databaseStatus: '오류 (error)',
    });
  });
});
