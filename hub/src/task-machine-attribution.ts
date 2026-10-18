import { userInfo } from 'node:os'
import { resolveHostedUrl } from './hosted-url.ts'
import { type Attribution, attributionFromInputs } from './task-attribution.ts'
import { hostedSignedInUser } from './task-client.ts'

const MACHINE_IDENTITY_CACHE_MS = 60_000

type SignedInUser = { id: string; name: string | null } | null
type MachineIdentityCache = {
  hostedUrl: string
  expiresAt: number
  user: SignedInUser
}

let machineIdentityCache: MachineIdentityCache | null = null

export async function machineAttribution(
  input: {
    env?: Record<string, string | undefined>
    machineUser?: string
    now?: number
    signedInUser?: typeof hostedSignedInUser
  } = {},
): Promise<Attribution> {
  const env = input.env ?? process.env
  const hostedUrl = resolveHostedUrl(env)
  let user: SignedInUser = null
  if (hostedUrl) {
    const now = input.now ?? Date.now()
    if (machineIdentityCache?.hostedUrl === hostedUrl && machineIdentityCache.expiresAt > now) {
      user = machineIdentityCache.user
    } else {
      try {
        user = await (input.signedInUser ?? hostedSignedInUser)({ baseUrl: hostedUrl })
      } catch {
        user = null
      }
      machineIdentityCache = { hostedUrl, expiresAt: now + MACHINE_IDENTITY_CACHE_MS, user }
    }
  }
  return attributionFromInputs({
    env,
    user,
    machineUser: input.machineUser ?? userInfo().username,
  })
}
