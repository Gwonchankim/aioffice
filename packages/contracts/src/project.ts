import { z } from 'zod';

import {
  absolutePathSchema,
  agentIdSchema,
  dataClassificationSchema,
  nfcStringSchema,
  normalizedUniqueStringArraySchema,
  projectKeySchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';

export const providerPolicySchema = z
  .object({
    openai: z.boolean(),
    anthropic: z.boolean(),
    allowFable: z.boolean(),
  })
  .strict();

const commandArgumentSchema = nfcStringSchema(1, 256).refine(
  // Intentionally rejects NUL and newline characters in command arguments.
  // eslint-disable-next-line no-control-regex
  (value) => !/[\u0000\r\n;&|<>`$()]/.test(value),
  'Command arguments cannot contain shell metacharacters.',
);

const commandArgvBaseSchema = z.array(commandArgumentSchema).min(1).max(4);

const exactCommandSchema = (command: readonly [string, ...string[]]) =>
  commandArgvBaseSchema.refine(
    (argv) =>
      argv.length === command.length && argv.every((value, index) => value === command[index]),
    `Expected the fixed command prefix: ${command.join(' ')}.`,
  );

export const readCommandArgvSchema = z.union([
  exactCommandSchema(['git', 'status']),
  exactCommandSchema(['git', 'diff']),
  exactCommandSchema(['git', 'log']),
  exactCommandSchema(['git', 'show']),
]);

export const verifyCommandArgvSchema = z.union([
  exactCommandSchema(['pnpm', 'test']),
  exactCommandSchema(['pnpm', 'lint']),
  exactCommandSchema(['pnpm', 'build']),
  exactCommandSchema(['pytest']),
  exactCommandSchema(['dotnet', 'test']),
]);

export const localWriteCommandArgvSchema = z.union([
  exactCommandSchema(['git', 'add']),
  exactCommandSchema(['git', 'commit']),
  exactCommandSchema(['git', 'cherry-pick']),
]);

export const commandArgvSchema = z.union([
  readCommandArgvSchema,
  verifyCommandArgvSchema,
  localWriteCommandArgvSchema,
]);

export const allowedCommandsSchema = z
  .object({
    read: z.array(readCommandArgvSchema).max(20),
    verify: z.array(verifyCommandArgvSchema).max(20),
    localWrite: z.array(localWriteCommandArgvSchema).max(20),
  })
  .strict();

const projectNameSchema = nfcStringSchema(1, 128);
const branchSchema = nfcStringSchema(1, 255);
const allowedAgentIdsSchema = normalizedUniqueStringArraySchema(1, 18, 1, 32).superRefine(
  (values, context) => {
    for (const [index, value] of values.entries()) {
      if (!agentIdSchema.safeParse(value).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Expected a catalog agent ID.',
          path: [index],
        });
      }
    }
  },
);

function addProviderPolicyIssues(
  classification: z.infer<typeof dataClassificationSchema>,
  policy: z.infer<typeof providerPolicySchema>,
  context: z.RefinementCtx,
): void {
  if (classification === 'confidential' && !policy.openai && !policy.anthropic) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Confidential projects require an OpenAI or Anthropic provider allowlist entry.',
      path: ['providerPolicy'],
    });
  }

  if (classification === 'controlled' && (policy.openai || policy.anthropic || policy.allowFable)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Controlled projects cannot enable a remote provider.',
      path: ['providerPolicy'],
    });
  }
}

const projectFields = {
  id: ulidSchema,
  projectKey: projectKeySchema,
  name: projectNameSchema,
  repositoryPath: absolutePathSchema,
  defaultBranch: branchSchema,
  classification: dataClassificationSchema,
  providerPolicy: providerPolicySchema,
  allowedAgentIds: allowedAgentIdsSchema,
  allowedCommands: allowedCommandsSchema,
  createdAt: utcIso8601Schema,
  updatedAt: utcIso8601Schema,
  unregisteredAt: utcIso8601Schema.nullable(),
};

export const projectSchema = z
  .object(projectFields)
  .strict()
  .superRefine((project, context) => {
    addProviderPolicyIssues(project.classification, project.providerPolicy, context);
  });

export const projectRegistrationInputSchema = z
  .object({
    projectKey: projectKeySchema,
    name: projectNameSchema,
    repositoryPath: absolutePathSchema,
    defaultBranch: branchSchema,
    classification: dataClassificationSchema,
    providerPolicy: providerPolicySchema,
    allowedAgentIds: allowedAgentIdsSchema,
    allowedCommands: allowedCommandsSchema,
    fableWarningConfirmationId: ulidSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    addProviderPolicyIssues(input.classification, input.providerPolicy, context);
    if (input.providerPolicy.allowFable && input.fableWarningConfirmationId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fable requires a session-bound warning confirmation.',
        path: ['fableWarningConfirmationId'],
      });
    }
    if (!input.providerPolicy.allowFable && input.fableWarningConfirmationId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A Fable warning confirmation is only valid when Fable is enabled.',
        path: ['fableWarningConfirmationId'],
      });
    }
  });

export const projectUpdateInputSchema = z
  .object({
    name: projectNameSchema.optional(),
    defaultBranch: branchSchema.optional(),
    classification: dataClassificationSchema.optional(),
    providerPolicy: providerPolicySchema.optional(),
    allowedAgentIds: allowedAgentIdsSchema.optional(),
    allowedCommands: allowedCommandsSchema.optional(),
    fableWarningConfirmationId: ulidSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected at least one mutable field.',
      });
    }
    if (input.providerPolicy?.allowFable && input.fableWarningConfirmationId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fable requires a session-bound warning confirmation.',
        path: ['fableWarningConfirmationId'],
      });
    }
  });

export const projectDeleteInputSchema = z.object({}).strict();

export const projectIdParamsSchema = z.object({ id: ulidSchema }).strict();

export const gitStatusSchema = z
  .object({
    defaultBranch: branchSchema,
    currentBranch: branchSchema.nullable(),
    headSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, 'Expected a Git commit SHA.'),
    dirty: z.boolean(),
  })
  .strict();

export const projectWithGitStatusSchema = z
  .object({
    project: projectSchema,
    git: gitStatusSchema,
  })
  .strict();

export const projectListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: nfcStringSchema(1, 1024).optional(),
  })
  .strict();

export const projectListDataSchema = z.object({ items: z.array(projectSchema) }).strict();

export const fableConfirmationCreateInputSchema = z
  .object({
    scope: z.literal('project-create'),
    projectKey: projectKeySchema,
    proposedProviderPolicy: providerPolicySchema,
    warningStatementVersion: nfcStringSchema(1, 128),
  })
  .strict();

export const fableConfirmationUpdateInputSchema = z
  .object({
    scope: z.literal('project-update'),
    projectId: ulidSchema,
    proposedProviderPolicy: providerPolicySchema,
    warningStatementVersion: nfcStringSchema(1, 128),
  })
  .strict();

export const fableConfirmationInputSchema = z.discriminatedUnion('scope', [
  fableConfirmationCreateInputSchema,
  fableConfirmationUpdateInputSchema,
]);

export const fableConfirmationDataSchema = z
  .object({
    confirmationId: ulidSchema,
    expiresAt: utcIso8601Schema,
    warningStatementVersion: nfcStringSchema(1, 128),
  })
  .strict();

export type ProviderPolicy = z.infer<typeof providerPolicySchema>;
export type CommandArgv = z.infer<typeof commandArgvSchema>;
export type AllowedCommands = z.infer<typeof allowedCommandsSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectRegistrationInput = z.infer<typeof projectRegistrationInputSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateInputSchema>;
export type ProjectWithGitStatus = z.infer<typeof projectWithGitStatusSchema>;
export type FableConfirmationInput = z.infer<typeof fableConfirmationInputSchema>;
