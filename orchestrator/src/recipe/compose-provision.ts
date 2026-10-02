// concern: built-in Compose lifecycle adapter
/** Inventories and executes the pure Compose plan on the host with bounded commands. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ComposeCommandPlan, composeCommandPlan } from './compose-provision-plan.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { StepResult } from './recipe-step.ts'

const COMPOSE_INVENTORY_TIMEOUT_MS = 10_000
const COMPOSE_OPERATION_TIMEOUT_MS = 120_000

export type ComposeProcessOutput = {
  exitCode: number | null
  stdout: Uint8Array
  stderr: string
  timedOut?: boolean
}

export type ComposeSpawn = (
  argv: string[],
  cwd: string,
  options: { timeoutMs: number },
) => ComposeProcessOutput

const defaultSpawn: ComposeSpawn = (argv, cwd, options) => {
  const process = Bun.spawnSync(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
  })
  return {
    exitCode: process.exitCode,
    stdout: process.stdout,
    stderr: process.stderr.toString(),
    timedOut: process.signalCode === 'SIGKILL',
  }
}

type ComposeContext = {
  treeRoot: string
  commandRoot?: string
  projectName: string
  rootRunId: number
  mainComposeProjects: readonly string[]
  treeExists?: boolean
}

type ComposeResource = { kind: 'container' | 'volume' | 'network'; name: string }

function result(
  phase: StepResult['phase'],
  status: StepResult['status'],
  detail = '',
  argv: string[] | null = null,
): StepResult {
  return {
    name: 'compose',
    phase,
    status,
    exitCode: status === 'ok' ? 0 : null,
    argv,
    detail,
    durationMs: 0,
  }
}

function commandText(argv: readonly string[]): string {
  return argv.join(' ')
}

function run(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  spawn: ComposeSpawn,
): ComposeProcessOutput {
  try {
    return spawn(argv, cwd, { timeoutMs })
  } catch {
    return { exitCode: null, stdout: new Uint8Array(), stderr: '' }
  }
}

function inventory(
  projectName: string,
  cwd: string,
  spawn: ComposeSpawn,
): { resources: ComposeResource[] } | { failure: StepResult } {
  const commands: { kind: ComposeResource['kind']; argv: string[] }[] = [
    {
      kind: 'container',
      argv: [
        'docker',
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Names}}',
      ],
    },
    {
      kind: 'volume',
      argv: [
        'docker',
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}',
      ],
    },
    {
      kind: 'network',
      argv: [
        'docker',
        'network',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}',
      ],
    },
  ]
  const resources: ComposeResource[] = []
  for (const command of commands) {
    const inspected = run(command.argv, cwd, COMPOSE_INVENTORY_TIMEOUT_MS, spawn)
    const remedy = `verify Docker is running, then retry or run docker compose -p ${projectName} down --volumes`
    if (inspected.timedOut) {
      return {
        failure: result(
          'verify',
          'failed',
          `${commandText(command.argv)} timed out after ${COMPOSE_INVENTORY_TIMEOUT_MS}ms; ${remedy}`,
          command.argv,
        ),
      }
    }
    if (inspected.exitCode !== 0) {
      return {
        failure: result(
          'verify',
          'failed',
          `${commandText(command.argv)} failed; ${remedy}`,
          command.argv,
        ),
      }
    }
    resources.push(
      ...new TextDecoder()
        .decode(inspected.stdout)
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ kind: command.kind, name })),
    )
  }
  return { resources }
}

function preparedPlan(
  recipe: TrackedRecipe,
  context: ComposeContext,
): { ok: true; plan: ComposeCommandPlan | null } | { ok: false; failure: StepResult } {
  try {
    return {
      ok: true,
      plan: composeCommandPlan({
        recipe,
        projectName: context.projectName,
        rootRunId: context.rootRunId,
        mainComposeProjects: context.mainComposeProjects,
      }),
    }
  } catch (error) {
    return {
      ok: false,
      failure: result('run', 'refused', String((error as Error)?.message ?? error)),
    }
  }
}

export function createCompose(
  recipe: TrackedRecipe,
  context: ComposeContext,
  spawn: ComposeSpawn = defaultSpawn,
  recordOwnership: () => void = () => {},
): { step: StepResult; owned: boolean } {
  const prepared = preparedPlan(recipe, context)
  if (!prepared.ok) return { step: prepared.failure, owned: false }
  if (!prepared.plan) return { step: result('run', 'ok'), owned: false }
  const { plan } = prepared
  const existing = inventory(plan.projectName, context.treeRoot, spawn)
  if ('failure' in existing) return { step: existing.failure, owned: false }
  if (existing.resources.length) {
    return {
      step: result(
        'run',
        'refused',
        `Compose project ${plan.projectName} already has resources (${existing.resources.map((resource) => resource.name).join(', ')}); run docker compose -p ${plan.projectName} down --volumes and retry`,
      ),
      owned: false,
    }
  }
  recordOwnership()
  const executed = run(plan.up, context.treeRoot, COMPOSE_OPERATION_TIMEOUT_MS, spawn)
  if (executed.timedOut) {
    return {
      step: result(
        'run',
        'failed',
        `${commandText(plan.up)} timed out after ${COMPOSE_OPERATION_TIMEOUT_MS}ms; run docker compose -p ${plan.projectName} down --volumes and retry`,
        plan.up,
      ),
      owned: true,
    }
  }
  return {
    step:
      executed.exitCode === 0
        ? result('run', 'ok', '', plan.up)
        : result(
            'run',
            'failed',
            `${commandText(plan.up)} failed; run docker compose -p ${plan.projectName} down --volumes and retry`,
            plan.up,
          ),
    owned: true,
  }
}

export function downCompose(
  recipe: TrackedRecipe,
  context: ComposeContext,
  owned: boolean | undefined,
  spawn: ComposeSpawn = defaultSpawn,
): StepResult {
  const prepared = preparedPlan(recipe, context)
  if (!prepared.ok) return { ...prepared.failure, phase: 'undo' }
  if (!prepared.plan) return result('undo', 'ok')
  const { plan } = prepared
  if (!owned) {
    return result(
      'undo',
      'ok',
      owned === false
        ? `Compose project ${plan.projectName} was not created by this lifecycle and was kept`
        : `Compose project ${plan.projectName} has no recorded ownership and was kept`,
    )
  }
  const argv = plan.down
  const cwd = mkdtempSync(join(tmpdir(), 'orch-compose-down-'))
  let executed: ComposeProcessOutput
  let remaining: ReturnType<typeof inventory>
  try {
    executed = run(argv, cwd, COMPOSE_OPERATION_TIMEOUT_MS, spawn)
    remaining = inventory(plan.projectName, cwd, spawn)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
  if ('failure' in remaining) return remaining.failure
  if (remaining.resources.length) {
    return result(
      'verify',
      'failed',
      `Compose project ${plan.projectName} still has resources after down: ${remaining.resources.map((resource) => `${resource.kind} ${resource.name}`).join(', ')}; remove them and retry teardown`,
      argv,
    )
  }
  if (executed.timedOut) {
    return result(
      'undo',
      'failed',
      `${commandText(argv)} timed out after ${COMPOSE_OPERATION_TIMEOUT_MS}ms; run docker compose -p ${plan.projectName} down --volumes --remove-orphans and retry`,
      argv,
    )
  }
  if (executed.exitCode !== 0) {
    return result(
      'undo',
      'failed',
      `${commandText(argv)} failed; run docker compose -p ${plan.projectName} down --volumes --remove-orphans and retry`,
      argv,
    )
  }
  return result('verify', 'ok', '', argv)
}
