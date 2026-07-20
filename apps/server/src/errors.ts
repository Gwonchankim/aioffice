export type ApplicationErrorCode =
  | 'PORT_EXHAUSTED'
  | 'PORT_BIND_FAILED'
  | 'RUNTIME_DIRECTORY_CREATE_FAILED'
  | 'RUNTIME_DIRECTORY_PERMISSION_DENIED'
  | 'RUNTIME_METADATA_WRITE_FAILED'
  | 'HEALTH_RESOURCE_MEASUREMENT_FAILED'
  | 'STATIC_ASSET_ROOT_INVALID';

export class ApplicationError extends Error {
  public readonly code: ApplicationErrorCode;

  public constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
  }
}

export class PortExhaustedError extends ApplicationError {
  public constructor() {
    super('PORT_EXHAUSTED', 'No loopback port is available in the configured range.');
    this.name = 'PortExhaustedError';
  }
}

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}
