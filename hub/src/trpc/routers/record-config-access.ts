import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { credentialPreferenceIdentitySchema } from '../../record-client.ts'
import type { Context } from '../context.ts'
import { email } from './record-inputs.ts'
import { recordClient } from './record-router-client.ts'

const t = initTRPC.context<Context>().create()
const emailInput = z.object({ email })

type RecordClient = ReturnType<typeof recordClient>

/** One space's credential listing, or why it could not be read, so one refusal never blanks the rest. */
async function spaceCredentials(client: RecordClient, space: { id: string; name: string }) {
  try {
    const [secrets, preferences, projects] = await Promise.all([
      client.configSecrets(space.id),
      client.credentialPreferences(space.id),
      client.projects(space.id),
    ])
    return { ...space, secrets, preferences, projects, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...space, secrets: [], preferences: [], projects: [], error: message }
  }
}

/** Every space the caller belongs to, with the credential metadata its runs resolve from. */
async function resolvedKeys(client: RecordClient) {
  const identity = await client.whoami()
  const spaces = identity.memberships.flatMap((membership) =>
    typeof membership.space_id === 'string' && typeof membership.name === 'string'
      ? [{ id: membership.space_id, name: membership.name }]
      : [],
  )
  return {
    userId: String(identity.user.id),
    personalSpaceId: identity.personalSpaceId,
    spaces: await Promise.all(spaces.map((space) => spaceCredentials(client, space))),
  }
}

export const recordConfigAccessRouter = t.router({
  configSecrets: t.procedure.query(({ ctx }) => recordClient(ctx).configSecrets()),
  credentialPreferences: t.procedure.query(({ ctx }) => recordClient(ctx).credentialPreferences()),
  resolvedKeys: t.procedure.query(({ ctx }) => resolvedKeys(recordClient(ctx))),
  clearCredentialPreference: t.procedure
    .input(credentialPreferenceIdentitySchema)
    .mutation(({ ctx, input }) => recordClient(ctx).clearCredentialPreference(input)),
  configAccess: t.procedure.query(({ ctx }) => recordClient(ctx).configAccess()),
  grantConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).grantConfigAccess(input.email)),
  withdrawConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).withdrawConfigAccess(input.email)),
})
