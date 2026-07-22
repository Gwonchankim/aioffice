import { StringDecoder } from 'node:string_decoder';

import type { NormalizedAdapterEvent, ProviderDiagnostics, RunResult } from '@orion/contracts';

import { ApplicationError } from '../errors.js';

export const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
export const MAX_PROVIDER_BUFFER_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_EVENT_IDENTITIES = 10_000;

export type ProviderFrameMapping =
  | {
      readonly kind: 'recognized';
      readonly providerEventId?: string;
      readonly sessionMarker?: string;
      readonly createEvents: (
        diagnostics: ProviderDiagnostics,
      ) => readonly NormalizedAdapterEvent[];
      readonly result?: RunResult;
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid'; readonly finalSchema?: boolean };

export type ProviderFrameMapper = (frame: unknown) => ProviderFrameMapping;

export class IncrementalLineParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly eventIds = new Set<string>();
  private readonly sessionMarkers = new Set<string>();
  private buffered = '';
  private invalidFrameCount = 0;
  private consecutiveInvalidFrameCount = 0;
  private unknownEventCount = 0;
  private terminalError: ApplicationError | undefined;
  private finalResult: RunResult | undefined;

  public constructor(private readonly mapFrame: ProviderFrameMapper) {}

  public push(chunk: Uint8Array): readonly NormalizedAdapterEvent[] {
    if (this.terminalError !== undefined) return [];
    const decoded = this.decoder.write(Buffer.from(chunk));
    return this.consume(decoded, false);
  }

  public finish(): readonly NormalizedAdapterEvent[] {
    if (this.terminalError !== undefined) return [];
    const decoded = this.decoder.end();
    const events = this.consume(decoded, true);
    return events;
  }

  public get diagnostics(): ProviderDiagnostics {
    return {
      invalidFrameCount: this.invalidFrameCount,
      consecutiveInvalidFrameCount: this.consecutiveInvalidFrameCount,
      unknownEventCount: this.unknownEventCount,
      stderrBytes: 0,
      stderrOmittedBytes: 0,
    };
  }

  public get error(): ApplicationError | undefined {
    return this.terminalError;
  }

  public get result(): RunResult | undefined {
    return this.finalResult;
  }

  private consume(decoded: string, final: boolean): readonly NormalizedAdapterEvent[] {
    if (
      Buffer.byteLength(this.buffered, 'utf8') + Buffer.byteLength(decoded, 'utf8') >
      MAX_PROVIDER_BUFFER_BYTES
    ) {
      this.failProtocol();
      return [];
    }

    this.buffered += decoded;
    const events: NormalizedAdapterEvent[] = [];
    let newlineAt = this.buffered.indexOf('\n');
    while (newlineAt >= 0) {
      const rawLine = this.buffered.slice(0, newlineAt);
      this.buffered = this.buffered.slice(newlineAt + 1);
      events.push(...this.consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine));
      if (this.terminalError !== undefined) return events;
      newlineAt = this.buffered.indexOf('\n');
    }

    if (Buffer.byteLength(this.buffered, 'utf8') > MAX_PROVIDER_LINE_BYTES) {
      this.failProtocol();
      return events;
    }
    if (final && this.buffered.length > 0) {
      events.push(
        ...this.consumeLine(
          this.buffered.endsWith('\r') ? this.buffered.slice(0, -1) : this.buffered,
        ),
      );
      this.buffered = '';
    }
    return events;
  }

  private consumeLine(line: string): readonly NormalizedAdapterEvent[] {
    if (Buffer.byteLength(line, 'utf8') > MAX_PROVIDER_LINE_BYTES) {
      this.failProtocol();
      return [];
    }
    if (line.length === 0) return [];

    let frame: unknown;
    try {
      frame = JSON.parse(line) as unknown;
    } catch {
      this.recordInvalid(false);
      return [];
    }

    const mapping = this.mapFrame(frame);
    if (mapping.kind === 'unknown') {
      this.unknownEventCount += 1;
      return [];
    }
    if (mapping.kind === 'invalid') {
      this.recordInvalid(mapping.finalSchema === true);
      return [];
    }

    this.consecutiveInvalidFrameCount = 0;
    if (!this.acceptIdentity(mapping)) return [];
    if (mapping.result !== undefined) {
      if (this.finalResult !== undefined) {
        this.failProtocol();
        return [];
      }
      this.finalResult = mapping.result;
    }
    return mapping.createEvents(this.diagnostics);
  }

  private acceptIdentity(
    mapping: Extract<ProviderFrameMapping, { readonly kind: 'recognized' }>,
  ): boolean {
    const identity = mapping.providerEventId;
    if (identity !== undefined) {
      if (this.eventIds.has(identity)) return false;
      if (this.eventIds.size >= MAX_PROVIDER_EVENT_IDENTITIES) {
        this.failProtocol();
        return false;
      }
      this.eventIds.add(identity);
    }
    if (mapping.sessionMarker !== undefined) {
      if (this.sessionMarkers.has(mapping.sessionMarker)) return false;
      if (this.sessionMarkers.size >= MAX_PROVIDER_EVENT_IDENTITIES) {
        this.failProtocol();
        return false;
      }
      this.sessionMarkers.add(mapping.sessionMarker);
    }
    return true;
  }

  private recordInvalid(finalSchema: boolean): void {
    this.invalidFrameCount += 1;
    this.consecutiveInvalidFrameCount += 1;
    if (finalSchema) {
      this.terminalError = new ApplicationError(
        'OUTPUT_SCHEMA_INVALID',
        'The provider final result does not match the required schema.',
      );
      return;
    }
    if (this.consecutiveInvalidFrameCount >= 5) this.failProtocol();
  }

  private failProtocol(): void {
    if (this.terminalError === undefined) {
      this.terminalError = new ApplicationError(
        'ADAPTER_PROTOCOL_ERROR',
        'The provider emitted an invalid streaming protocol.',
      );
    }
  }
}
