type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Keep browser credentials on every hub request and surface a local expired session. */
export async function fetchWithHubCredentials(
  fetcher: Fetcher,
  hosted: boolean,
  onLocalUnauthorized: () => void,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetcher(input, {
    ...(init ?? {}),
    credentials: hosted ? 'include' : 'same-origin',
  })
  if (!hosted && response.status === 401) onLocalUnauthorized()
  return response
}
