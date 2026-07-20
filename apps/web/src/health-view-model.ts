import type { HealthSuccess } from '@orion/contracts';

export interface HealthViewModel {
  overallStatus: string;
  databaseStatus: string;
  schedulerStatus: string;
  retentionStatus: string;
  memoryPercent: string;
  freeDiskBytes: string;
}

const notInitializedStatus = '초기화되지 않음';

export function createHealthViewModel(health: HealthSuccess): HealthViewModel | null {
  const subsystemStatuses = [
    health.data.database,
    health.data.scheduler.status,
    health.data.retention.status,
  ];

  if (
    health.data.status !== 'degraded' ||
    subsystemStatuses.some((status) => status !== 'not_initialized')
  ) {
    return null;
  }

  return {
    overallStatus: '저하됨 (degraded)',
    databaseStatus: notInitializedStatus,
    schedulerStatus: notInitializedStatus,
    retentionStatus: notInitializedStatus,
    memoryPercent: String(health.data.resources.memoryPercent),
    freeDiskBytes: String(health.data.resources.freeDiskBytes),
  };
}
