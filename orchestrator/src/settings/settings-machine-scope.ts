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

export type ClaudeMcpPlacement = {
  scope: 'user' | 'local'
  projectPaths: string[]
}

export type ClaudeMcpPlacementCall =
  | { action: 'inspect-and-remove-user'; scope: 'user' }
  | { action: 'remove'; scope: 'user' }
  | { action: 'add'; scope: 'user' }
  | { action: 'remove' | 'add'; scope: 'local'; projectPath: string }

export type ClaudeMcpPlacementDecision = {
  initial: ClaudeMcpPlacement
  desired: ClaudeMcpPlacement
  calls: ClaudeMcpPlacementCall[]
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

export function desiredClaudeMcpPlacement(plan: MachineSettingsScopePlan): ClaudeMcpPlacement {
  return plan.user.mcp
    ? { scope: 'user', projectPaths: [] }
    : {
        scope: 'local',
        projectPaths: plan.projects
          .filter((project) => project.action === 'render-and-register')
          .map((project) => project.path),
      }
}

/** Decide the minimum Claude CLI calls from the placement Bottega last applied. */
export function decideClaudeMcpPlacementCalls(
  recorded: ClaudeMcpPlacement | null,
  desired: ClaudeMcpPlacement,
): ClaudeMcpPlacementDecision {
  const initial = recorded ?? { scope: 'user', projectPaths: [] }
  if (!recorded && desired.scope === 'local') {
    return {
      initial,
      desired,
      calls: [
        { action: 'inspect-and-remove-user', scope: 'user' },
        ...desired.projectPaths.map(
          (projectPath): ClaudeMcpPlacementCall => ({ action: 'add', scope: 'local', projectPath }),
        ),
      ],
    }
  }
  if (initial.scope === 'user' && desired.scope === 'user') {
    return { initial, desired, calls: [] }
  }
  if (initial.scope === 'user') {
    return {
      initial,
      desired,
      calls: [
        { action: 'remove', scope: 'user' },
        ...desired.projectPaths.map(
          (projectPath): ClaudeMcpPlacementCall => ({ action: 'add', scope: 'local', projectPath }),
        ),
      ],
    }
  }
  const desiredPaths = new Set(desired.projectPaths)
  const recordedPaths = new Set(initial.projectPaths)
  const removals: ClaudeMcpPlacementCall[] = initial.projectPaths
    .filter((projectPath) => !desiredPaths.has(projectPath))
    .map((projectPath) => ({ action: 'remove', scope: 'local', projectPath }))
  if (desired.scope === 'user') {
    return {
      initial,
      desired,
      calls: [...removals, { action: 'add', scope: 'user' }],
    }
  }
  return {
    initial,
    desired,
    calls: [
      ...removals,
      ...desired.projectPaths
        .filter((projectPath) => !recordedPaths.has(projectPath))
        .map(
          (projectPath): ClaudeMcpPlacementCall => ({ action: 'add', scope: 'local', projectPath }),
        ),
    ],
  }
}

export function placementAfterClaudeMcpCall(
  current: ClaudeMcpPlacement,
  call: ClaudeMcpPlacementCall,
): ClaudeMcpPlacement {
  if (call.scope === 'user') {
    return call.action === 'add'
      ? { scope: 'user', projectPaths: [] }
      : { scope: 'local', projectPaths: [] }
  }
  const paths = new Set(current.scope === 'local' ? current.projectPaths : [])
  if (call.action === 'add') paths.add(call.projectPath)
  else paths.delete(call.projectPath)
  return { scope: 'local', projectPaths: [...paths] }
}

export function scopedProjectHasDrift(settingsMatch: boolean, mcpMatches: boolean): boolean {
  return !settingsMatch || !mcpMatches
}
