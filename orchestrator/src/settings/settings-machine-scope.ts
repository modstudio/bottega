// concern: settings-machine-scope
/** Pure decision for placing rendered Claude settings and MCP registration. */

export type RegisteredProjectScopeFact = {
  path: string
  exists: boolean
  gitMainCheckout: boolean
}

export type MachineSettingsScopePlan = {
  user: { rendered: 'all' | 'hooks'; mcp: boolean }
  projects: Array<{
    path: string
    action: 'render-and-register' | 'remove-rendered-and-registration' | 'skip'
    reason?: 'missing path' | 'not a git main checkout'
  }>
}

export function decideMachineSettingsScope(
  globalUse: 'on' | 'off',
  projects: readonly RegisteredProjectScopeFact[],
): MachineSettingsScopePlan {
  return {
    user: { rendered: globalUse === 'on' ? 'all' : 'hooks', mcp: globalUse === 'on' },
    projects: projects.map((project) => {
      if (!project.exists)
        return { path: project.path, action: 'skip', reason: 'missing path' } as const
      if (!project.gitMainCheckout)
        return {
          path: project.path,
          action: 'skip',
          reason: 'not a git main checkout',
        } as const
      return {
        path: project.path,
        action: globalUse === 'off' ? 'render-and-register' : 'remove-rendered-and-registration',
      } as const
    }),
  }
}

export function scopedProjectHasDrift(settingsMatch: boolean, mcpMatches: boolean): boolean {
  return !settingsMatch || !mcpMatches
}
