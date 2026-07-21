import type { DataClassification } from '@orion/contracts';

import { ApplicationError } from './errors.js';

export interface RegistryTransferCandidate {
  readonly sourceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly classification: DataClassification;
}

export interface RegistryTransferPort {
  transfer(candidate: RegistryTransferCandidate): Promise<void>;
}

export class MetadataOnlyRegistryTransferService {
  public constructor(private readonly port: RegistryTransferPort) {}

  public async transfer(candidate: RegistryTransferCandidate): Promise<void> {
    if (candidate.classification === 'controlled') {
      throw new ApplicationError(
        'CONTROLLED_EXECUTION_BLOCKED',
        'Controlled metadata cannot cross a transfer boundary.',
        { statusCode: 403 },
      );
    }
    await this.port.transfer({
      ...candidate,
      summary: candidate.summary === null ? null : candidate.summary.slice(0, 4000),
    });
  }
}

export class NoopRegistryTransferPort implements RegistryTransferPort {
  public async transfer(): Promise<void> {
    // M1 deliberately has no remote connector or provider transfer implementation.
  }
}
