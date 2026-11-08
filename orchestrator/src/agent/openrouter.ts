// concern: OpenRouter endpoint identity
/** Decides whether an agent endpoint is served through OpenRouter. */

const OPENROUTER_HOST = 'openrouter.ai'

export function isOpenRouterBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname === OPENROUTER_HOST
  } catch {
    return false
  }
}
