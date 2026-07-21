export type ApplicationErrorCode =
  | 'PORT_EXHAUSTED'
  | 'PORT_BIND_FAILED'
  | 'RUNTIME_DIRECTORY_CREATE_FAILED'
  | 'RUNTIME_DIRECTORY_PERMISSION_DENIED'
  | 'RUNTIME_METADATA_WRITE_FAILED'
  | 'HEALTH_RESOURCE_MEASUREMENT_FAILED'
  | 'STATIC_ASSET_ROOT_INVALID'
  | 'DATABASE_OPEN_FAILED'
  | 'DATABASE_CONFIGURATION_FAILED'
  | 'MIGRATION_FAILED'
  | 'DATABASE_UNAVAILABLE'
  | 'SESSION_REQUIRED'
  | 'HOST_REJECTED'
  | 'ORIGIN_REJECTED'
  | 'CSRF_REJECTED'
  | 'IDEMPOTENCY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONTROLLED_EXECUTION_BLOCKED'
  | 'PROJECT_CONFLICT'
  | 'PROJECT_POLICY_CONFLICT'
  | 'PROJECT_UNREGISTERED'
  | 'REPOSITORY_MUTATED_DURING_REGISTRATION'
  | 'TASK_EXECUTION_CONFLICT'
  | 'WORKTREE_CONFLICT'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INVALID_STATE_TRANSITION'
  | 'IMMUTABLE_PROFILE_SNAPSHOT'
  | 'ARCHIVE_APPROVAL_INVALID';

export class ApplicationError extends Error {
  public readonly code: ApplicationErrorCode;
  public readonly details: unknown;
  public readonly statusCode: number;
  public readonly retryable: boolean;

  public constructor(
    code: ApplicationErrorCode,
    message: string,
    options: {
      readonly details?: unknown;
      readonly statusCode?: number;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.details = options.details;
    this.statusCode = options.statusCode ?? defaultStatus(code);
    this.retryable = options.retryable ?? false;
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

export function asApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  const code = getErrorCode(error);
  if (code === 'INVALID_STATE_TRANSITION' || code === 'IMMUTABLE_PROFILE_SNAPSHOT') {
    return new ApplicationError(code, 'The requested state change is not permitted.', {
      statusCode: 409,
    });
  }
  return new ApplicationError('DATABASE_UNAVAILABLE', 'The local database operation failed.', {
    statusCode: 503,
    retryable: true,
  });
}

function defaultStatus(code: ApplicationErrorCode): number {
  switch (code) {
    case 'SESSION_REQUIRED':
      return 401;
    case 'HOST_REJECTED':
    case 'ORIGIN_REJECTED':
    case 'CSRF_REJECTED':
    case 'CONTROLLED_EXECUTION_BLOCKED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'PROJECT_CONFLICT':
    case 'PROJECT_POLICY_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'TASK_EXECUTION_CONFLICT':
    case 'WORKTREE_CONFLICT':
    case 'INVALID_STATE_TRANSITION':
    case 'IMMUTABLE_PROFILE_SNAPSHOT':
      return 409;
    case 'VALIDATION_FAILED':
      return 422;
    case 'HEALTH_RESOURCE_MEASUREMENT_FAILED':
    case 'DATABASE_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}
