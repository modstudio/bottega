import { PLATFORM_SLUG } from '../shared/brand.ts'

export const HUB_PACKAGE_PREFIX = `@${PLATFORM_SLUG}/hub-`
export const HUB_UI_PACKAGE = `${HUB_PACKAGE_PREFIX}ui`
export const HUB_VIEWS_PACKAGE = `${HUB_PACKAGE_PREFIX}views`
export const HUB_DATA_PACKAGE = `${HUB_PACKAGE_PREFIX}data`
const HUB_WEB_PACKAGE = `${HUB_PACKAGE_PREFIX}web`
const HUB_SITE_PACKAGE = `${HUB_PACKAGE_PREFIX}site`
export const HUB_UI_ROOT = 'hub/ui'
export const HUB_VIEWS_ROOT = 'hub/views'
export const HUB_DATA_ROOT = 'hub/data'

export const hubWorkspaceDependencies: Record<string, readonly string[]> = {
  [HUB_UI_PACKAGE]: [],
  [HUB_VIEWS_PACKAGE]: [HUB_UI_PACKAGE],
  [HUB_DATA_PACKAGE]: [],
  [HUB_WEB_PACKAGE]: [HUB_UI_PACKAGE, HUB_VIEWS_PACKAGE, HUB_DATA_PACKAGE],
  [HUB_SITE_PACKAGE]: [],
}
