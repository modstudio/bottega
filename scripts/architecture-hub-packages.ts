import { PLATFORM_SLUG } from '../shared/brand.ts'

export const HUB_PACKAGE_PREFIX = `@${PLATFORM_SLUG}/hub-`
export const HUB_UI_PACKAGE = `${HUB_PACKAGE_PREFIX}ui`
export const HUB_VIEWS_PACKAGE = `${HUB_PACKAGE_PREFIX}views`
export const HUB_DATA_PACKAGE = `${HUB_PACKAGE_PREFIX}data`
export const HUB_UTIL_PACKAGE = `${HUB_PACKAGE_PREFIX}util`
const HUB_WEB_PACKAGE = `${HUB_PACKAGE_PREFIX}web`
const HUB_SITE_PACKAGE = `${HUB_PACKAGE_PREFIX}site`
export const HUB_UI_ROOT = 'hub/ui'
export const HUB_VIEWS_ROOT = 'hub/views'
export const HUB_DATA_ROOT = 'hub/data'
export const HUB_UTIL_ROOT = 'hub/util'

export const hubWorkspaceDependencies: Record<string, readonly string[]> = {
  [HUB_UI_PACKAGE]: [],
  [HUB_VIEWS_PACKAGE]: [HUB_UI_PACKAGE],
  [HUB_DATA_PACKAGE]: [],
  [HUB_UTIL_PACKAGE]: [],
  [HUB_WEB_PACKAGE]: [HUB_UI_PACKAGE, HUB_VIEWS_PACKAGE, HUB_DATA_PACKAGE, HUB_UTIL_PACKAGE],
  [HUB_SITE_PACKAGE]: [],
}

/** Keep the pure helper package independent from workspace and UI/runtime packages. */
export function hubUtilArchitectureRules(dependencyPath: (target: string) => string) {
  return [
    {
      name: 'hub-util-is-pure-and-ui-independent',
      severity: 'error' as const,
      comment: 'Hub util imports only platform-shared helpers and non-UI runtime dependencies.',
      from: { path: '^hub/util/src/' },
      to: {
        path: [
          '^hub/(?:data|ui|views|web|src)/',
          `^@${PLATFORM_SLUG}/`,
          '^react(?:-dom)?$',
          '^@tanstack/',
          '^@trpc/',
          '^lucide-react$',
          'node_modules/@tanstack/',
          'node_modules/@trpc/',
          dependencyPath('react'),
          dependencyPath('react-dom'),
          dependencyPath('lucide-react'),
        ].join('|'),
      },
    },
  ]
}
