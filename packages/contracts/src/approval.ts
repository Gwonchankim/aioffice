import { z } from 'zod';

import {
  actionHashSchema,
  positiveSafeIntegerSchema,
  projectKeySchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';

export const approvalActionSchema = z.literal('source_card.archive');
export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const approvalSchema = z
  .object({
    id: ulidSchema,
    action: approvalActionSchema,
    sourceId: ulidSchema,
    projectKey: projectKeySchema,
    metadataVersion: positiveSafeIntegerSchema,
    actionHash: actionHashSchema,
    status: approvalStatusSchema,
    expiresAt: utcIso8601Schema,
    consumedAt: utcIso8601Schema.nullable(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.consumedAt !== null && approval.status !== 'approved') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only approved archive bindings can be consumed.',
        path: ['consumedAt'],
      });
    }
  });

export const archiveApprovalCommandSchema = z
  .object({
    sourceId: ulidSchema,
    projectId: projectKeySchema,
    expectedMetadataVersion: positiveSafeIntegerSchema,
    action: approvalActionSchema,
    actionHash: actionHashSchema,
    approvalId: ulidSchema,
  })
  .strict();

export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type ArchiveApprovalCommand = z.infer<typeof archiveApprovalCommandSchema>;
