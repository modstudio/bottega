export type JsonBodyFailure = {
  ok: false
  url: string
  status: number
  contentType: string
}

export type JsonBodyResult = { ok: true; value: unknown } | JsonBodyFailure

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i

function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value.split(/[?#]/, 1)[0]!
  }
}

export async function jsonBody(response: Response, url: string): Promise<JsonBodyResult> {
  const contentType = response.headers.get('content-type') ?? 'missing'
  if (!JSON_MEDIA_TYPE.test(contentType))
    return {
      ok: false,
      url: diagnosticUrl(url),
      status: response.status,
      contentType,
    }
  try {
    return { ok: true, value: await response.json() }
  } catch {
    return {
      ok: false,
      url: diagnosticUrl(url),
      status: response.status,
      contentType,
    }
  }
}

/** Format the two hosted-response failures callers expose to operators. */
export function hostedJsonFailureMessage(failure: JsonBodyFailure): string {
  const source = new URL(failure.url)
  if (failure.status < 200 || failure.status >= 300)
    return hostedStatusMessage(failure.url, failure.status)
  return `hosted response from ${source.host}${source.pathname} was not JSON (status ${failure.status}, content-type ${failure.contentType})`
}

export function hostedStatusMessage(url: string, status: number): string {
  return `${new URL(url).host} answered ${status}`
}
