export type NetworkGuardEnvironment = Record<string, string | undefined>
export type NetworkGuardDecision = 'allow' | 'refuse'
export type NetworkRequestInput = string | URL | Request

function requestUrl(input: NetworkRequestInput): string {
  return input instanceof Request ? input.url : String(input)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/** Decides whether a gate test may reach the requested network host. */
export function testNetworkRequestDecision(
  input: NetworkRequestInput,
  environment: NetworkGuardEnvironment,
): NetworkGuardDecision {
  if (environment.BOTTEGA_TEST_POSTGRES_CONTAINER) return 'allow'
  try {
    return isLoopbackHostname(new URL(requestUrl(input)).hostname) ? 'allow' : 'refuse'
  } catch {
    return 'refuse'
  }
}

export function testNetworkRefusal(input: NetworkRequestInput): string {
  return (
    `test network guard refuses ${requestUrl(input)}; ` +
    'stub globalThis.fetch in the test, or set BOTTEGA_TEST_POSTGRES_CONTAINER'
  )
}

function copyFetchProperties(target: typeof fetch, source: typeof fetch): void {
  for (const key of Reflect.ownKeys(source)) {
    if (Reflect.has(target, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor) Object.defineProperty(target, key, descriptor)
  }
}

/** Replaces global fetch with a guard over the supplied fetch implementation. */
export function installTestNetworkGuard(
  innerFetch: typeof fetch = globalThis.fetch,
  environment: NetworkGuardEnvironment = process.env,
): typeof fetch {
  const guardedFetch = (async (input: NetworkRequestInput, init?: RequestInit) => {
    if (testNetworkRequestDecision(input, environment) === 'refuse') {
      throw new Error(testNetworkRefusal(input))
    }
    return await innerFetch(input, init)
  }) as typeof fetch
  copyFetchProperties(guardedFetch, innerFetch)
  globalThis.fetch = guardedFetch
  return guardedFetch
}
