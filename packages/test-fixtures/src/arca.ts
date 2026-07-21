export const syntheticProjectKey = 'orion_contract_fixture';
export const syntheticProjectId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

export const syntheticSourceCard = {
  sourceId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  title: '합성 계약 검증 자료',
  summary: '승인된 최소 합성 요약입니다.',
  tags: ['synthetic', '계약'],
  projectId: syntheticProjectKey,
  connectorType: 'local-folder',
  locator: 'C:\\Synthetic\\orion-contract-fixture\\metadata.md',
  owner: 'synthetic-team',
  classification: 'internal',
  allowedRoles: ['advisor', 'knowledge-registry'],
  version: 'v1',
  checksumAlgorithm: 'sha256',
  checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  recordedAt: '2026-07-21T09:00:00.000Z',
  lastVerifiedAt: '2026-07-21T09:05:00.000Z',
  status: 'active',
  supersedesSourceId: null,
  metadataVersion: 1,
} as const;

export const syntheticRegisterSourceInput = {
  title: syntheticSourceCard.title,
  summary: syntheticSourceCard.summary,
  tags: syntheticSourceCard.tags,
  projectId: syntheticProjectKey,
  connectorType: syntheticSourceCard.connectorType,
  locator: syntheticSourceCard.locator,
  owner: syntheticSourceCard.owner,
  classification: syntheticSourceCard.classification,
  allowedRoles: syntheticSourceCard.allowedRoles,
  version: syntheticSourceCard.version,
  checksumAlgorithm: syntheticSourceCard.checksumAlgorithm,
  checksum: syntheticSourceCard.checksum,
  supersedesSourceId: null,
} as const;

export const syntheticSourceRequest = {
  requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  projectId: syntheticProjectKey,
  requestedMaterial: '합성 검증용 자료 목록',
  criteria: '계약 검증에 필요한 최소 metadata',
  acceptableFormats: ['markdown', 'json'],
  expectedLocations: ['C:\\Synthetic\\orion-contract-fixture'],
  purpose: 'contract-verification',
  requesterRole: 'knowledge-registry',
  requestedAt: '2026-07-21T09:10:00.000Z',
  resolvedBySourceId: null,
  resolvedAt: null,
  status: 'open',
  metadataVersion: 1,
} as const;

export const forbiddenSourceFieldFixtures = [
  { rawContent: 'synthetic raw content is forbidden' },
  { rawExcerpt: 'synthetic raw excerpt is forbidden' },
  { credentials: 'synthetic credential-shaped value is forbidden' },
  { prompt: 'synthetic prompt is forbidden' },
  { toolLog: 'synthetic tool log is forbidden' },
] as const;
