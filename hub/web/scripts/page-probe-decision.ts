export type ParameterizedRoute = {
  template: string
  parent: string
}

export const PARAMETERIZED_ROUTES: readonly ParameterizedRoute[] = [
  { template: '/runs/$id', parent: '/runs' },
  { template: '/board/tasks/$key', parent: '/board' },
  { template: '/done/tasks/$key', parent: '/done' },
  { template: '/flight/tasks/$key', parent: '/flight' },
  { template: '/reviews/$id', parent: '/reviews' },
  { template: '/messages/$id', parent: '/messages' },
  { template: '/projects/$name', parent: '/projects' },
  { template: '/docs/$scope/$subject/$slug', parent: '/docs' },
  { template: '/inbox/$kind/$id', parent: '/inbox' },
]

function routePattern(template: string): RegExp {
  const parts = template
    .split('/')
    .map((part) => (part.startsWith('$') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  return new RegExp(`^${parts.join('/')}/?$`)
}

/** Pick the first same-origin link whose path has the parameterized route's exact shape. */
export function firstSampleLink(
  template: string,
  hrefs: readonly string[],
  origin: string,
): string | null {
  const pattern = routePattern(template)
  for (const href of hrefs) {
    try {
      const url = new URL(href, origin)
      if (url.origin === origin && pattern.test(url.pathname)) return `${url.pathname}${url.search}`
    } catch {
      // A malformed href cannot be a route sample.
    }
  }
  return null
}

export function slowestFirst<T extends { settleMs: number | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (right.settleMs ?? -1) - (left.settleMs ?? -1))
}
