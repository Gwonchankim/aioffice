import { z } from 'zod';

import { errorEnvelopeSchema, successEnvelopeSchema } from './envelope.js';
import {
  fableConfirmationDataSchema,
  fableConfirmationInputSchema,
  projectDeleteInputSchema,
  projectIdParamsSchema,
  projectListDataSchema,
  projectListQuerySchema,
  projectRegistrationInputSchema,
  projectSchema,
  projectUpdateInputSchema,
  projectWithGitStatusSchema,
} from './project.js';
import { taskStatusSchema } from './task.js';
import { nfcStringSchema, ulidSchema } from './base.js';

export const projectListSuccessSchema = successEnvelopeSchema(projectListDataSchema);
export const projectWithGitStatusSuccessSchema = successEnvelopeSchema(projectWithGitStatusSchema);
export const projectDeleteSuccessSchema = successEnvelopeSchema(
  z.object({ project: projectSchema }).strict(),
);
export const fableConfirmationSuccessSchema = successEnvelopeSchema(fableConfirmationDataSchema);

export const taskExecutionConflictDetailsSchema = z
  .object({
    projectId: ulidSchema,
    tasks: z.array(z.object({ id: ulidSchema, status: taskStatusSchema }).strict()).min(1),
  })
  .strict();

export const worktreeConflictDetailsSchema = z
  .object({
    projectId: ulidSchema,
    worktrees: z
      .array(
        z
          .object({
            id: ulidSchema,
            status: z.enum(['active', 'preserved']),
            path: nfcStringSchema(1, 2048),
            branch: nfcStringSchema(1, 255),
            taskId: ulidSchema.nullable(),
            runId: ulidSchema.nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const projectRouteRegistry = {
  fableConfirmations: {
    method: 'POST',
    path: '/api/v1/provider-policy/fable-confirmations',
    body: fableConfirmationInputSchema,
    responses: {
      201: fableConfirmationSuccessSchema,
      400: errorEnvelopeSchema,
      401: errorEnvelopeSchema,
      403: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      422: errorEnvelopeSchema,
    },
  },
  listProjects: {
    method: 'GET',
    path: '/api/v1/projects',
    query: projectListQuerySchema,
    responses: { 200: projectListSuccessSchema, 401: errorEnvelopeSchema },
  },
  createProject: {
    method: 'POST',
    path: '/api/v1/projects',
    body: projectRegistrationInputSchema,
    responses: {
      201: projectWithGitStatusSuccessSchema,
      400: errorEnvelopeSchema,
      401: errorEnvelopeSchema,
      403: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      422: errorEnvelopeSchema,
    },
  },
  getProject: {
    method: 'GET',
    path: '/api/v1/projects/{id}',
    params: projectIdParamsSchema,
    responses: {
      200: projectWithGitStatusSuccessSchema,
      401: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
    },
  },
  updateProject: {
    method: 'PATCH',
    path: '/api/v1/projects/{id}',
    params: projectIdParamsSchema,
    body: projectUpdateInputSchema,
    responses: {
      200: projectWithGitStatusSuccessSchema,
      400: errorEnvelopeSchema,
      401: errorEnvelopeSchema,
      403: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      422: errorEnvelopeSchema,
    },
  },
  deleteProject: {
    method: 'DELETE',
    path: '/api/v1/projects/{id}',
    params: projectIdParamsSchema,
    body: projectDeleteInputSchema,
    responses: {
      200: projectDeleteSuccessSchema,
      400: errorEnvelopeSchema,
      401: errorEnvelopeSchema,
      403: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
    },
  },
} as const;

export type ProjectRouteRegistry = typeof projectRouteRegistry;
