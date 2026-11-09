import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_MODES,
  CREDENTIAL_SLUG_PATTERN,
} from '../../../../shared/credential.ts'
import type { Context } from '../context.ts'
import { email } from './record-inputs.ts'
import { recordClient } from './record-router-client.ts'

const t = initTRPC.context<Context>().create()
const emailInput = z.object({ email })
const credentialPreferenceIdentityInput = z.object({
  projectId: z.string().uuid().nullable(),
  provider: z.string().regex(CREDENTIAL_SLUG_PATTERN),
  name: z.string().regex(CREDENTIAL_SLUG_PATTERN).nullable(),
  type: z.string().regex(CREDENTIAL_SLUG_PATTERN),
  mode: z.enum(CREDENTIAL_MODES),
  environment: z.enum(CREDENTIAL_ENVIRONMENTS),
})

export const recordConfigAccessRouter = t.router({
  configSecrets: t.procedure.query(({ ctx }) => recordClient(ctx).configSecrets()),
  credentialPreferences: t.procedure.query(({ ctx }) => recordClient(ctx).credentialPreferences()),
  clearCredentialPreference: t.procedure
    .input(credentialPreferenceIdentityInput)
    .mutation(({ ctx, input }) => recordClient(ctx).clearCredentialPreference(input)),
  configAccess: t.procedure.query(({ ctx }) => recordClient(ctx).configAccess()),
  grantConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).grantConfigAccess(input.email)),
  withdrawConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).withdrawConfigAccess(input.email)),
})
