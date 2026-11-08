// concern: record-api-config-schema
/** Validates hosted secret writes before ciphertext or metadata reaches the service. */

import { z } from 'zod'
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_MODES,
  CREDENTIAL_SLUG_PATTERN,
} from '../../../shared/credential.ts'
import { base64urlSchema, idSchema } from './record-api-wire.ts'
import { CONFIG_SCOPES } from './record-config.ts'

export const configSecretPutBody = z
  .object({
    environment: z.string().min(1),
    scope: z.enum(CONFIG_SCOPES),
    expectedRowVersion: z.number().int().positive().nullable(),
    dekId: idSchema,
    envelope: base64urlSchema,
    projectId: idSchema.nullable().optional(),
    provider: z.string().regex(CREDENTIAL_SLUG_PATTERN).nullable().optional(),
    name: z.string().regex(CREDENTIAL_SLUG_PATTERN).nullable().optional(),
    type: z.string().regex(CREDENTIAL_SLUG_PATTERN).nullable().optional(),
    hint: z.string().min(1).nullable().optional(),
    mode: z.enum(CREDENTIAL_MODES).nullable().optional(),
  })
  .refine(
    ({ projectId, provider, name, type, hint, mode, environment }) => {
      const values = [provider ?? null, type ?? null, hint ?? null, mode ?? null]
      const credential =
        values.every((value) => value !== null) &&
        CREDENTIAL_ENVIRONMENTS.includes(environment as (typeof CREDENTIAL_ENVIRONMENTS)[number])
      const legacy =
        values.every((value) => value === null) &&
        (name ?? null) === null &&
        (projectId ?? null) === null
      return credential || legacy
    },
    { message: 'credential metadata must be complete and projectId requires credential metadata' },
  )
