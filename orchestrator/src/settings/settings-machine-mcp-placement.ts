// concern: settings-machine-mcp-placement
/** Persists the machine-only record of Claude MCP placement applied by Bottega. */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { claudeMcpPlacementPath, type StateEnvironment } from '../../../shared/state-directory.ts'
import type {
  ClaudeMcpRegistrationPort,
  McpServer,
  mutateClaudeMcpRegistration,
  reconcileClaudeMcpRegistration,
} from '../setup/setup-mcp.ts'
import {
  type ClaudeMcpPlacement,
  type ClaudeMcpPlacementCall,
  type ClaudeMcpPlacementDecision,
  decideClaudeMcpPlacementCalls,
  desiredClaudeMcpPlacement,
  type MachineSettingsScopePlan,
  placementAfterClaudeMcpCall,
} from './settings-machine-scope.ts'

export type ClaudeMcpPlacementResult = {
  target: string
  outcome: 'applied' | 'current' | 'refused'
  changed: boolean
  detail?: string
}

type ReconcileInput = Parameters<typeof reconcileClaudeMcpRegistration>[0]
type MutateInput = Parameters<typeof mutateClaudeMcpRegistration>[0]
type PlacementDependencies = {
  environment: StateEnvironment
  port(): ClaudeMcpRegistrationPort | null
  server: McpServer
  read: typeof readClaudeMcpPlacement
  write: typeof writeClaudeMcpPlacement
  reconcile(input: ReconcileInput): { changed: boolean; detail?: string }
  mutate(input: MutateInput): void
}

function parsePlacement(value: unknown): ClaudeMcpPlacement {
  if (!value || typeof value !== 'object') throw new Error('record is not an object')
  const candidate = value as { scope?: unknown; projectPaths?: unknown }
  if (candidate.scope !== 'user' && candidate.scope !== 'local') {
    throw new Error('scope must be user or local')
  }
  if (
    !Array.isArray(candidate.projectPaths) ||
    !candidate.projectPaths.every((path) => typeof path === 'string')
  ) {
    throw new Error('projectPaths must be a string array')
  }
  if (candidate.scope === 'user' && candidate.projectPaths.length) {
    throw new Error('user scope cannot contain project paths')
  }
  return { scope: candidate.scope, projectPaths: [...new Set(candidate.projectPaths)] }
}

export function readClaudeMcpPlacement(environment: StateEnvironment): ClaudeMcpPlacement | null {
  const path = claudeMcpPlacementPath(environment)
  if (!existsSync(path)) return null
  try {
    return parsePlacement(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid Claude MCP placement record ${path}: ${detail}`)
  }
}

export function writeClaudeMcpPlacement(
  environment: StateEnvironment,
  placement: ClaudeMcpPlacement,
): void {
  const path = claudeMcpPlacementPath(environment)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(placement, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function target(call: ClaudeMcpPlacementCall): string {
  return call.scope === 'user' ? 'MCP claude user' : `MCP claude project ${call.projectPath}`
}

function result(targetName: string, changed: boolean, detail?: string): ClaudeMcpPlacementResult {
  return {
    target: targetName,
    outcome: changed ? 'applied' : 'current',
    changed,
    ...(detail ? { detail } : {}),
  }
}

function refused(targetName: string, error: unknown): ClaudeMcpPlacementResult {
  return {
    target: targetName,
    outcome: 'refused',
    changed: false,
    detail: error instanceof Error ? error.message : String(error),
  }
}

function plannedTargets(plan: MachineSettingsScopePlan): string[] {
  return [
    'MCP claude user',
    ...plan.projects
      .filter((project) => project.action !== 'skip')
      .map((project) => `MCP claude project ${project.path}`),
  ]
}

function checkPlacement(
  plan: MachineSettingsScopePlan,
  deps: PlacementDependencies,
): ClaudeMcpPlacementResult[] {
  const port = deps.port()
  if (!port) {
    return plannedTargets(plan).map((name) => refused(name, 'Claude executable was not found'))
  }
  const inputs: Array<{ target: string; scope: 'user' | 'local'; cwd?: string; present: boolean }> =
    [
      { target: 'MCP claude user', scope: 'user', present: plan.user.mcp },
      ...plan.projects
        .filter((project) => project.action !== 'skip')
        .map((project) => ({
          target: `MCP claude project ${project.path}`,
          scope: 'local' as const,
          cwd: project.path,
          present: project.action === 'render-and-register',
        })),
    ]
  return inputs.map((input) => {
    try {
      const reconciled = deps.reconcile({
        port,
        server: deps.server,
        scope: input.scope,
        cwd: input.cwd,
        present: input.present,
        check: true,
      })
      return result(input.target, reconciled.changed, reconciled.detail)
    } catch (error) {
      return refused(input.target, error)
    }
  })
}

function applyPlacementCalls(
  decision: ClaudeMcpPlacementDecision,
  deps: PlacementDependencies,
  results: Map<string, ClaudeMcpPlacementResult>,
): ClaudeMcpPlacementResult[] {
  const port = deps.port()
  if (!port) {
    for (const call of decision.calls) {
      results.set(target(call), refused(target(call), 'Claude executable was not found'))
    }
    return [...results.values()]
  }
  let current = decision.initial
  for (const [index, call] of decision.calls.entries()) {
    const name = target(call)
    try {
      if (call.action === 'inspect-and-remove-user') {
        const reconciled = deps.reconcile({
          port,
          server: deps.server,
          scope: 'user',
          present: false,
          check: false,
        })
        results.set(name, result(name, reconciled.changed, reconciled.detail))
      } else {
        deps.mutate({
          port,
          server: deps.server,
          action: call.action,
          scope: call.scope,
          ...(call.scope === 'local' ? { cwd: call.projectPath } : {}),
        })
        results.set(name, result(name, true))
      }
      current = placementAfterClaudeMcpCall(current, call)
      deps.write(deps.environment, current)
    } catch (error) {
      results.set(name, refused(name, error))
      for (const pending of decision.calls.slice(index + 1)) {
        const pendingTarget = target(pending)
        results.set(pendingTarget, refused(pendingTarget, `not applied after ${name} was refused`))
      }
      break
    }
  }
  return [...results.values()]
}

/** Reconcile writes from the placement record; only --check reads every Claude scope. */
export function reconcileClaudeMcpPlacementPlan(
  check: boolean,
  plan: MachineSettingsScopePlan,
  deps: PlacementDependencies,
): ClaudeMcpPlacementResult[] {
  if (check) return checkPlacement(plan, deps)
  const names = plannedTargets(plan)
  let recorded: ClaudeMcpPlacement | null
  try {
    recorded = deps.read(deps.environment)
  } catch (error) {
    return names.map((name) => refused(name, error))
  }
  const decision = decideClaudeMcpPlacementCalls(recorded, desiredClaudeMcpPlacement(plan))
  const results = new Map(names.map((name) => [name, result(name, false)]))
  if (!decision.calls.length) {
    if (!recorded) {
      try {
        deps.write(deps.environment, decision.desired)
      } catch (error) {
        results.set('MCP claude user', refused('MCP claude user', error))
      }
    }
    return [...results.values()]
  }
  return applyPlacementCalls(decision, deps, results)
}
