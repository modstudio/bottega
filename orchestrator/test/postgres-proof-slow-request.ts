// Test-only hosted request timing for the Postgres proof. Must not know production clients.

const PROOF_SLOW_REQUEST_MS = 5_000

export async function timedHostedRequest<T>(
  input: {
    test: string
    operation: 'sync' | 'whoami'
  },
  request: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now()
  const originalFetch = globalThis.fetch
  const routes = new Set<string>()
  let pendingResponseHeaders = 0
  let receivedResponseHeaders = false
  globalThis.fetch = (async (resource, init) => {
    const url = resource instanceof Request ? resource.url : String(resource)
    try {
      routes.add(new URL(url).pathname)
    } catch {
      routes.add(url)
    }
    pendingResponseHeaders++
    try {
      const response = await originalFetch(resource, init)
      receivedResponseHeaders = true
      return response
    } finally {
      pendingResponseHeaders--
    }
  }) as typeof fetch
  let logged = false
  const logSlowRequest = () => {
    if (logged) return
    logged = true
    const elapsedMs = Math.round(performance.now() - startedAt)
    const phase = receivedResponseHeaders && pendingResponseHeaders === 0 ? 'response' : 'unknown'
    console.error(
      `postgres RLS proof slow request: test="${input.test}" operation=${input.operation} routes="${[...routes].join(', ') || 'unknown'}" elapsed_ms=${elapsedMs} phase=${phase}`,
    )
  }
  const timer = setTimeout(logSlowRequest, PROOF_SLOW_REQUEST_MS)
  let outcome: 'resolved' | 'rejected' = 'rejected'
  try {
    const result = await request()
    outcome = 'resolved'
    return result
  } finally {
    clearTimeout(timer)
    globalThis.fetch = originalFetch
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs >= PROOF_SLOW_REQUEST_MS) {
      logSlowRequest()
      console.error(
        `postgres RLS proof slow request settled: test="${input.test}" operation=${input.operation} routes="${[...routes].join(', ') || 'unknown'}" elapsed_ms=${Math.round(elapsedMs)} outcome=${outcome}`,
      )
    }
  }
}
