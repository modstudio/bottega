import type { RecordClient } from './record-client.ts'

type ResolvedKeysClient = Pick<
  RecordClient,
  'whoami' | 'configSecrets' | 'credentialPreferences' | 'projects'
>

/** One space's credential listing, or why it could not be read, so one refusal never blanks the rest. */
async function spaceCredentials(client: ResolvedKeysClient, space: { id: string; name: string }) {
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
export async function hostedResolvedKeys(client: ResolvedKeysClient) {
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
