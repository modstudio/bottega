import { PLATFORM_SLUG } from '../shared/brand.ts'

export const HUB_PACKAGE_PREFIX = `@${PLATFORM_SLUG}/hub-`
export const HUB_UI_PACKAGE = `${HUB_PACKAGE_PREFIX}ui`
const HUB_WEB_PACKAGE = `${HUB_PACKAGE_PREFIX}web`
export const HUB_UI_ROOT = 'hub/ui'

export const hubWorkspaceDependencies: Record<string, readonly string[]> = {
  [HUB_UI_PACKAGE]: [],
  [HUB_WEB_PACKAGE]: [HUB_UI_PACKAGE],
}
