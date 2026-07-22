import { randomBytes } from 'node:crypto';

import { ApplicationError } from '../errors.js';
import type { ProviderProcessHandle } from './provider-process.js';

export interface OwnedProviderProcess {
  readonly runtimeHandle: string;
  readonly runId: string;
  readonly rootPid: number;
  readonly nonce: string;
}

interface OwnershipRecord extends OwnedProviderProcess {
  readonly child: ProviderProcessHandle;
  cancelledAt: number | undefined;
  timedOutAt: number | undefined;
  forceTimer: NodeJS.Timeout | undefined;
  closed: boolean;
}

export class ChildProcessOwnershipRegistry {
  private readonly records = new Map<string, OwnershipRecord>();
  private readonly knownRecords = new WeakSet<OwnershipRecord>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly forceDelayMs = 5_000,
  ) {}

  public register(runId: string, child: ProviderProcessHandle): OwnedProviderProcess {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new ApplicationError(
        'PROVIDER_UNAVAILABLE',
        'The provider process did not provide a valid process ID.',
      );
    }
    const runtimeHandle = randomBytes(24).toString('base64url');
    const record: OwnershipRecord = {
      runtimeHandle,
      runId,
      rootPid: child.pid,
      nonce: randomBytes(16).toString('base64url'),
      child,
      cancelledAt: undefined,
      timedOutAt: undefined,
      forceTimer: undefined,
      closed: false,
    };
    this.records.set(runtimeHandle, record);
    this.knownRecords.add(record);
    void child.exited.then(
      () => this.close(record),
      () => this.close(record),
    );
    return record;
  }

  public async cancel(runtimeHandle: string): Promise<void> {
    const record = this.requireLive(runtimeHandle);
    if (record.cancelledAt !== undefined) {
      await record.child.exited;
      return;
    }
    if (record.timedOutAt !== undefined) return;
    record.cancelledAt = this.now();
    this.stop(record);
    await record.child.exited;
    await this.verifyNoDescendants(record);
  }

  public markTimedOut(owned: OwnedProviderProcess): void {
    const record = this.requireOwned(owned);
    if (record.closed || record.cancelledAt !== undefined || record.timedOutAt !== undefined)
      return;
    record.timedOutAt = this.now();
    this.stop(record);
  }

  public terminateForFailure(owned: OwnedProviderProcess): void {
    const record = this.requireOwned(owned);
    if (record.closed) return;
    this.stop(record);
  }

  public wasCancelled(owned: OwnedProviderProcess): boolean {
    return this.requireOwned(owned).cancelledAt !== undefined;
  }

  public wasTimedOut(owned: OwnedProviderProcess): boolean {
    return this.requireOwned(owned).timedOutAt !== undefined;
  }

  public async verifyClosed(owned: OwnedProviderProcess): Promise<void> {
    const record = this.requireOwned(owned);
    await record.child.exited;
    await this.verifyNoDescendants(record);
  }

  public has(runtimeHandle: string): boolean {
    return this.records.has(runtimeHandle);
  }

  private stop(record: OwnershipRecord): void {
    record.child.requestGracefulTermination();
    record.forceTimer = setTimeout(() => {
      if (!record.closed) record.child.terminateOwnedTree();
    }, this.forceDelayMs);
  }

  private requireLive(runtimeHandle: string): OwnershipRecord {
    const record = this.records.get(runtimeHandle);
    if (record === undefined || record.closed) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The provider process handle is not owned by this runtime.',
      );
    }
    return record;
  }

  private requireOwned(owned: OwnedProviderProcess): OwnershipRecord {
    const record = owned as OwnershipRecord;
    if (
      !this.knownRecords.has(record) ||
      record.rootPid !== owned.rootPid ||
      record.nonce !== owned.nonce
    ) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The provider process handle is not owned by this runtime.',
      );
    }
    return record;
  }

  private close(record: OwnershipRecord): void {
    record.closed = true;
    if (record.forceTimer !== undefined) clearTimeout(record.forceTimer);
    this.records.delete(record.runtimeHandle);
  }

  private async verifyNoDescendants(record: OwnershipRecord): Promise<void> {
    const descendants = await record.child.countOwnedDescendants();
    if (descendants !== 0) {
      throw new ApplicationError(
        'PROVIDER_EXECUTION_FAILED',
        'The provider process did not stop its owned child processes.',
      );
    }
  }
}
