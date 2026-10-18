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

const HUB_UTIL_ALLOWED_IMPORT_PATHS = ['^hub/util/src/', '^shared/'] as const
const TYPESCRIPT_TEST_PATH = '\\.(?:test|spec)\\.[cm]?tsx?$'

export const hubWorkspaceDependencies: Record<string, readonly string[]> = {
  [HUB_UI_PACKAGE]: [],
  [HUB_VIEWS_PACKAGE]: [HUB_UI_PACKAGE],
  [HUB_DATA_PACKAGE]: [],
  [HUB_UTIL_PACKAGE]: [],
  [HUB_WEB_PACKAGE]: [HUB_UI_PACKAGE, HUB_VIEWS_PACKAGE, HUB_DATA_PACKAGE, HUB_UTIL_PACKAGE],
  [HUB_SITE_PACKAGE]: [],
}

/** Report runtime dependency fields forbidden in the pure helper package. */
export function hubUtilRuntimeDependencyViolations(packageJson: {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}) {
  return (['dependencies', 'peerDependencies'] as const).flatMap((field) =>
    Object.keys(packageJson[field] ?? {}).map(
      (dependency) => `hub/util/package.json: ${field} may not declare ${dependency}`,
    ),
  )
}

/** Keep the pure helper package limited to itself and repository-shared helpers. */
export function hubUtilArchitectureRules() {
  return [
    {
      name: 'hub-util-is-pure-and-ui-independent',
      severity: 'error' as const,
      comment: 'Hub util imports only its own relative modules and repository-shared helpers.',
      from: { path: '^hub/util/src/', pathNot: [TYPESCRIPT_TEST_PATH] },
      to: { pathNot: [...HUB_UTIL_ALLOWED_IMPORT_PATHS] },
    },
  ]
}
