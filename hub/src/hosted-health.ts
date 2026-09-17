export function hostedHealthResponse(request: Request): Response | null {
  const url = new URL(request.url)
  if (url.pathname !== '/health') return null
  const acceptsHtml = request.headers
    .get('accept')
    ?.split(',')
    .some((value) => value.split(';', 1)[0]?.trim().toLowerCase() === 'text/html')
  return acceptsHtml ? null : Response.json({ ok: true })
}
