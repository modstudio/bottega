// concern: hosted-config-client
/** Shares selected hosted configuration reads within one process. */

export const RECORD_WHOAMI_ROUTE = '/v1/whoami'

type MemoIdentity = object
type ReadMemo = Map<string, Map<string, Map<string, Promise<unknown>>>>

let readsByIdentity = new WeakMap<MemoIdentity, ReadMemo>()

function identityReads(identityKey: MemoIdentity): ReadMemo {
  const existing = readsByIdentity.get(identityKey)
  if (existing) return existing
  const created: ReadMemo = new Map()
  readsByIdentity.set(identityKey, created)
  return created
}

function tokenReads(
  identityKey: MemoIdentity,
  baseUrl: string,
  token: string,
): Map<string, Promise<unknown>> {
  const byUrl = identityReads(identityKey)
  let byToken = byUrl.get(baseUrl)
  if (!byToken) {
    byToken = new Map()
    byUrl.set(baseUrl, byToken)
  }
  let byPath = byToken.get(token)
  if (!byPath) {
    byPath = new Map()
    byToken.set(token, byPath)
  }
  return byPath
}

export function memoizedConfigRead<T>(
  identityKey: MemoIdentity,
  baseUrl: string,
  token: string,
  path: string,
  destinationSpaceId: string | undefined,
  projectId: string | null | undefined,
  load: () => Promise<T>,
): Promise<T> {
  const byPath = tokenReads(identityKey, baseUrl, token)
  const tenantPath = JSON.stringify([path, destinationSpaceId ?? '', projectId ?? ''])
  const existing = byPath.get(tenantPath)
  if (existing) return existing as Promise<T>
  const read = load().catch((error) => {
    if (byPath.get(tenantPath) === read) byPath.delete(tenantPath)
    throw error
  })
  byPath.set(tenantPath, read)
  return read
}

export function isMemoizedConfigRead(path: string): boolean {
  return (
    path === RECORD_WHOAMI_ROUTE ||
    path === '/v1/config/secrets' ||
    path.startsWith('/v1/config/secrets?') ||
    path === '/v1/config/credential-preferences' ||
    path === '/v1/config/trust-log'
  )
}

export function clearConfigReadMemo(
  identityKey: MemoIdentity,
  baseUrl: string,
  token: string,
): void {
  const byUrl = readsByIdentity.get(identityKey)
  const byToken = byUrl?.get(baseUrl)
  byToken?.delete(token)
  if (byToken?.size === 0) byUrl?.delete(baseUrl)
  if (byUrl?.size === 0) readsByIdentity.delete(identityKey)
}

export function forgetConfigReadMemo(): void {
  readsByIdentity = new WeakMap()
}
