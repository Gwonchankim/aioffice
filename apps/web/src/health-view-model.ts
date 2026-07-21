import type { HealthSuccess } from '@orion/contracts';

export interface HealthViewModel {
  overallStatus: string;
  databaseStatus: string;
  schedulerStatus: string;
  retentionStatus: string;
  memoryPercent: string;
  freeDiskBytes: string;
}

const statusLabels = {
  healthy: '정상 (healthy)',
  degraded: '저하됨 (degraded)',
  unhealthy: '비정상 (unhealthy)',
  ok: '정상 (ok)',
  error: '오류 (error)',
  not_initialized: '초기화되지 않음',
} as const;

export function createHealthViewModel(health: HealthSuccess): HealthViewModel {
  return {
    overallStatus: statusLabels[health.data.status],
    databaseStatus: statusLabels[health.data.database],
    schedulerStatus: statusLabels[health.data.scheduler.status],
    retentionStatus: statusLabels[health.data.retention.status],
    memoryPercent: String(health.data.resources.memoryPercent),
    freeDiskBytes: String(health.data.resources.freeDiskBytes),
  };
}
