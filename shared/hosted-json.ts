// concern: hosted JSON response reader
/** Reads one hosted response body while distinguishing empty and unusable error bodies. */

export type HostedJsonResult =
  | { kind: 'json'; value: unknown }
  | { kind: 'empty' }
  | { kind: 'absent' }

function responseSource(url: string): string {
  const source = new URL(url)
  return `${source.host}${source.pathname}`
}

/** Read a hosted response exactly once, rejecting successful non-JSON proxy or SPA bodies. */
export async function readHostedJson(response: Response, url: string): Promise<HostedJsonResult> {
  const text = await response.text()
  if (text.length === 0) return response.ok ? { kind: 'empty' } : { kind: 'absent' }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    if (!response.ok) return { kind: 'absent' }
    const contentType = response.headers.get('content-type') ?? 'missing'
    throw new Error(
      `hosted response from ${responseSource(url)} was not JSON (status ${response.status}, content-type ${contentType})`,
    )
  }

  const contentType = response.headers.get('content-type') ?? 'missing'
  if (response.ok && contentType.toLowerCase().includes('text/html')) {
    throw new Error(
      `hosted response from ${responseSource(url)} was not JSON (status ${response.status}, content-type ${contentType})`,
    )
  }
  return { kind: 'json', value }
}
