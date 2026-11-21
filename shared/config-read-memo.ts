// concern: hosted-config-client
/** Shares selected hosted configuration reads within one process. */

type Transport = object
type ReadMemo = Map<string, Map<string, Map<string, Promise<unknown>>>>

let readsByTransport = new WeakMap<Transport, ReadMemo>()

function transportReads(transport: Transport): ReadMemo {
  const existing = readsByTransport.get(transport)
  if (existing) return existing
  const created: ReadMemo = new Map()
  readsByTransport.set(transport, created)
  return created
}

function tokenReads(
  transport: Transport,
  baseUrl: string,
  token: string,
): Map<string, Promise<unknown>> {
  const byUrl = transportReads(transport)
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
  transport: Transport,
  baseUrl: string,
  token: string,
  path: string,
  load: () => Promise<T>,
): Promise<T> {
  const byPath = tokenReads(transport, baseUrl, token)
  const existing = byPath.get(path)
  if (existing) return existing as Promise<T>
  const read = load().catch((error) => {
    if (byPath.get(path) === read) byPath.delete(path)
    throw error
  })
  byPath.set(path, read)
  return read
}

export function clearConfigReadMemo(transport: Transport, baseUrl: string, token: string): void {
  const byUrl = readsByTransport.get(transport)
  const byToken = byUrl?.get(baseUrl)
  byToken?.delete(token)
  if (byToken?.size === 0) byUrl?.delete(baseUrl)
  if (byUrl?.size === 0) readsByTransport.delete(transport)
}

export function forgetConfigReadMemo(): void {
  readsByTransport = new WeakMap()
}
