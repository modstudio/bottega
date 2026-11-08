// concern: record-api-config-schema
/** Validates hosted secret writes before ciphertext or metadata reaches the service. */

import { z } from 'zod'
import { CREDENTIAL_SLUG_PATTERN } from '../../../shared/credential.ts'
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
    type: z.string().regex(CREDENTIAL_SLUG_PATTERN).nullable().optional(),
    hint: z.string().min(1).nullable().optional(),
  })
  .refine(
    ({ projectId, provider, type, hint }) => {
      const values = [provider ?? null, type ?? null, hint ?? null]
      const credential = values.every((value) => value !== null)
      const legacy = values.every((value) => value === null) && (projectId ?? null) === null
      return credential || legacy
    },
    { message: 'credential metadata must be complete and projectId requires credential metadata' },
  )
