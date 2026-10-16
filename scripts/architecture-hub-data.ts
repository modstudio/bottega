type ArchitectureRule = {
  name: string
  severity: 'error'
  comment?: string
  from: { path: string; pathNot?: string[] }
  to: { path?: string; dependencyTypesNot?: string[] }
}

type RouterException = {
  from: string
  to: string
  dependencyTypes: string[]
  reason: string
}

export function hubDataArchitectureRules(
  dependencyPath: (target: string) => string,
  exactPath: (target: string) => string,
  uiPackage: string,
  dataPackage: string,
  routerException: RouterException,
) {
  const viewDataRule: ArchitectureRule = {
    name: 'hub-web-views-do-not-fetch-data-or-read-hub-mode',
    severity: 'error',
    comment:
      'Hub views may not fetch data or read hub mode; move the data access into the route and pass the data down as props.',
    from: {
      path: '^hub/web/src/',
      pathNot: [
        '^hub/web/src/routes/',
        '^hub/web/src/(?:main|router)\\.tsx$',
        '^hub/web/src/.*\\.test\\.tsx?$',
      ],
    },
    to: {
      path: `(?:^hub/data/src/|${dependencyPath(dataPackage)}|${dependencyPath('@tanstack/react-query')}|^@trpc/|(^|/)node_modules/@trpc/[^/]+(?:/|$))`,
    },
  }
  const boundaryRules: ArchitectureRule[] = [
    {
      name: 'hub-data-imports-no-ui-or-web',
      severity: 'error',
      comment: 'Hub data owns data access and may not import presentation or the web package.',
      from: { path: '^hub/data/src/' },
      to: {
        path: `(?:^${uiPackage}/|${dependencyPath(uiPackage)}|^hub/(?:ui|web)/)`,
      },
    },
    {
      name: 'hub-data-router-is-type-only',
      severity: 'error',
      comment: routerException.reason,
      from: { path: `^${routerException.from}/` },
      to: {
        path: exactPath(routerException.to),
        dependencyTypesNot: routerException.dependencyTypes,
      },
    },
  ]
  return { viewDataRule, boundaryRules }
}
