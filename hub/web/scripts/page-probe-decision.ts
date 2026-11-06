/** Unauthenticated and product pages: checked for a response and a render, never timed. */
export const UNTIMED_ROUTES = [
  '/sign-in',
  '/forgot-password',
  '/reset-password',
  '/accept-invitation/probe',
  '/unsubscribe/probe/probe',
  '/product/board',
  '/product/context',
  '/product/doc-store',
  '/product/orchestration',
  '/product/review',
  '/product/workers',
  '/product/workflows',
] as const

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

/** The path template a TanStack route file declares, or null for a route without parameters. */
export function routeFileTemplate(file: string): string | null {
  const name = file.replace(/\.tsx$/, '')
  if (!name.includes('$')) return null
  return `/${name
    .split('.')
    .map((segment) => segment.replace(/_$/, ''))
    .join('/')}`
}

/** Route templates that no parameterized or untimed probe entry covers. */
export function unprobedRouteTemplates(templates: readonly string[]): string[] {
  const probed = new Set(PARAMETERIZED_ROUTES.map((route) => route.template))
  return templates.filter(
    (template) =>
      !probed.has(template) && !UNTIMED_ROUTES.some((route) => routePattern(template).test(route)),
  )
}
