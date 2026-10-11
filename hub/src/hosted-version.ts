import { builtCommitResponse } from '../../shared/built-commit.ts'

export function hostedVersionResponse(
  request: Request,
  commit: string | undefined,
): Response | null {
  const url = new URL(request.url)
  if (url.pathname !== '/version') return null
  const response = builtCommitResponse(commit)
  return Response.json(response.body, { status: response.status })
}
