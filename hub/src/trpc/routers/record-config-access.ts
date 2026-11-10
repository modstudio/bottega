import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { hostedResolvedKeys } from '../../hosted-resolved-keys.ts'
import { credentialPreferenceIdentitySchema } from '../../record-client.ts'
import type { Context } from '../context.ts'
import { email, spaceId } from './record-inputs.ts'
import { recordClient } from './record-router-client.ts'

const t = initTRPC.context<Context>().create()
const emailInput = z.object({ email, spaceId })

export const recordConfigAccessRouter = t.router({
  configSecrets: t.procedure.query(({ ctx }) => recordClient(ctx).configSecrets()),
  credentialPreferences: t.procedure.query(({ ctx }) => recordClient(ctx).credentialPreferences()),
  resolvedKeys: t.procedure.query(({ ctx }) => hostedResolvedKeys(recordClient(ctx))),
  clearCredentialPreference: t.procedure
    .input(credentialPreferenceIdentitySchema.extend({ spaceId }))
    .mutation(({ ctx, input }) => {
      const { spaceId: destination, ...preference } = input
      return recordClient(ctx).clearCredentialPreference(preference, destination)
    }),
  configAccess: t.procedure.query(({ ctx }) => recordClient(ctx).configAccess()),
  grantConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).grantConfigAccess(input.email, input.spaceId)),
  withdrawConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) =>
      recordClient(ctx).withdrawConfigAccess(input.email, input.spaceId),
    ),
})
