export function hostedVersionResponse(
  request: Request,
  commit: string | undefined,
): Response | null {
  const url = new URL(request.url)
  if (url.pathname !== '/version') return null
  return commit
    ? Response.json({ commit })
    : Response.json(
        { commit: null, error: 'the commit this app was built from is unknown' },
        { status: 503 },
      )
}
