export const expiresAt = '2099-01-01T00:00:00.000Z'

export function headers(token: string, spaceId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(spaceId ? { 'x-record-space': spaceId } : {}),
  }
}

export function activeSpaceFixture() {
  const spaces = new Map<string, string>()
  return {
    set: (token: string, spaceId: string) => spaces.set(token, spaceId),
    get: (token: string) => {
      const spaceId = spaces.get(token)
      if (!spaceId) throw new Error('board API proof token has no active space')
      return spaceId
    },
  }
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

export const noticeForProjects =
  (projectIds: Record<string, string>) =>
  (id: string, audience: string, authorSession: string, extra: Record<string, unknown> = {}) => {
    const audienceProject = audience.includes(':')
      ? audience.slice(audience.indexOf(':') + 1)
      : null
    const namedProject = typeof extra.project === 'string' ? extra.project : audienceProject
    return notice(id, audience, authorSession, {
      ...(namedProject && projectIds[namedProject] ? { projectId: projectIds[namedProject] } : {}),
      ...extra,
    })
  }
