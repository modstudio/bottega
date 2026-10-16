export const hubWorkspaceDependencies = {
  '@bottega/hub-ui': [],
  '@bottega/hub-web': ['@bottega/hub-ui'],
} as const satisfies Record<string, readonly string[]>

export const HUB_UI_PACKAGE = '@bottega/hub-ui'
export const HUB_UI_ROOT = 'hub/ui'
