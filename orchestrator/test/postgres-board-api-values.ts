export const expiresAt = '2099-01-01T00:00:00.000Z'

export function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

export function notice(
  id: string,
  audience: string,
  authorSession: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'notice',
    audience,
    title: `title-${id.slice(0, 8)}`,
    body: `body-${id}`,
    expiresAt,
    authorSession,
    ...extra,
  }
}
