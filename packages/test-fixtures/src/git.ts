export const syntheticRepositoryPath = 'C:\\Synthetic\\orion-contract-fixture';

export const syntheticGitStatus = {
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  branch: 'main',
  dirty: false,
} as const;

export const syntheticAllowedCommands = {
  read: [
    ['git', 'status'],
    ['git', 'diff'],
  ],
  verify: [
    ['pnpm', 'test'],
    ['pnpm', 'build'],
  ],
  localWrite: [
    ['git', 'add'],
    ['git', 'commit'],
  ],
} as const;
