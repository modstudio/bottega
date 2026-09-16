// concern: tracked recipe step execution
/** Knows only how to plan and execute one validated recipe step. Must not know recipe ordering, worktree lifecycle, claims, or the project register. */
import { isAbsolute, relative, resolve } from 'node:path'
import type { TrackedRecipe } from './recipe-schema.ts'
import { expandedSeed } from './worktree-template.ts'

export type Step = TrackedRecipe['create'][number]
export type Command = Step['run']
export type ExecContext = Step['exec']
export type StepContext = { treeRoot: string; vars: Record<string, string> }

export type CommandPlan = { ok: true; argv: string[]; cwd: string } | { ok: false; reason: string }

type SpawnResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type Spawn = (argv: string[], cwd: string) => SpawnResult

export type StepResult = {
  name: string
  phase: 'run' | 'verify' | 'undo'
  status: 'ok' | 'failed' | 'refused'
  exitCode: number | null
  argv: string[] | null
  detail: string
  durationMs: number
}

export type StepProcessResult = SpawnResult & {
  name: string
  phase: StepResult['phase']
  argv: string[]
  durationMs: number
  error?: string
}

const PLACEHOLDER = /\{([^{}]+)\}/g

function unavailablePlaceholder(value: string, vars: Record<string, string>): string | null {
  for (const match of value.matchAll(PLACEHOLDER)) {
    if (!(match[1]! in vars)) return match[1]!
  }
  return null
}

function fill(value: string, vars: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (_placeholder, name: string) => vars[name]!)
}

function commandStrings(command: Command, vars: Record<string, string>): string[] {
  return [
    command.command,
    ...command.args.flatMap((arg) => {
      if (typeof arg === 'string') return [arg]
      return 'value' in arg && vars[arg.omitWhenEmpty] ? [arg.value] : []
    }),
  ]
}

function insideTree(treeRoot: string, cwd: string): boolean {
  const path = relative(treeRoot, cwd)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function stepCommandPlan(
  command: Command,
  exec: ExecContext,
  context: StepContext,
  step = 'step',
  phase: StepResult['phase'] = 'run',
): CommandPlan {
  for (const value of commandStrings(command, context.vars)) {
    const missing = unavailablePlaceholder(value, context.vars)
    if (missing) {
      return { ok: false, reason: `unavailable placeholder {${missing}} in ${step}.${phase}` }
    }
  }

  if (exec?.where === 'container' && command.cwd !== undefined) {
    return {
      ok: false,
      reason: `cwd rule: step "${step}" runs in a container, where cwd is not supported`,
    }
  }

  const treeRoot = resolve(context.treeRoot)
  const cwd = exec?.where === 'container' ? treeRoot : resolve(treeRoot, command.cwd ?? '.')
  if (!insideTree(treeRoot, cwd)) {
    return { ok: false, reason: `cwd rule: ${phase} cwd for step "${step}" escapes the tree root` }
  }

  const args: string[] = []
  for (const arg of command.args) {
    if (typeof arg === 'string') {
      args.push(fill(arg, context.vars))
    } else if ('expand' in arg) {
      args.push(...expandedSeed(context.vars.seed ?? ''))
    } else if (context.vars[arg.omitWhenEmpty]) {
      args.push(fill(arg.value, context.vars))
    }
  }
  const argv = [fill(command.command, context.vars), ...args]
  if (exec?.where === 'as-user') {
    return { ok: true, argv: ['sudo', '-n', '-u', exec.user, '--', ...argv], cwd }
  }
  if (exec?.where === 'container') {
    return {
      ok: true,
      argv: ['docker', 'compose', 'exec', '-T', exec.service, ...argv],
      cwd,
    }
  }
  return { ok: true, argv, cwd }
}

function failureDetail(result: StepProcessResult): string {
  if (result.error) return result.error
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd()
  if (!combined) return ''
  return combined.split(/\r?\n/).slice(-20).join('\n')
}

export function stepOutcome(
  runResult: StepProcessResult,
  verifyResult: StepProcessResult | null,
): StepResult {
  const deciding = runResult.exitCode === 0 && verifyResult ? verifyResult : runResult
  const durationMs =
    runResult.durationMs + (deciding === verifyResult ? verifyResult.durationMs : 0)
  return {
    name: deciding.name,
    phase: deciding.phase,
    status: deciding.exitCode === 0 ? 'ok' : 'failed',
    exitCode: deciding.exitCode,
    argv: deciding.argv,
    detail: deciding.exitCode === 0 ? '' : failureDetail(deciding),
    durationMs,
  }
}

const defaultSpawn: Spawn = (argv, cwd) => {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function execute(
  name: string,
  phase: StepResult['phase'],
  plan: Extract<CommandPlan, { ok: true }>,
  spawn: Spawn,
): StepProcessResult {
  const started = performance.now()
  try {
    return {
      name,
      phase,
      argv: plan.argv,
      ...spawn(plan.argv, plan.cwd),
      durationMs: performance.now() - started,
    }
  } catch (error) {
    return {
      name,
      phase,
      argv: plan.argv,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: String((error as Error)?.message ?? error),
      durationMs: performance.now() - started,
    }
  }
}

function refused(
  name: string,
  phase: StepResult['phase'],
  reason: string,
  durationMs: number,
): StepResult {
  return { name, phase, status: 'refused', exitCode: null, argv: null, detail: reason, durationMs }
}

export function runStep(step: Step, context: StepContext, spawn: Spawn = defaultSpawn): StepResult {
  const started = performance.now()
  const runPlan = stepCommandPlan(step.run, step.exec, context, step.name, 'run')
  if (!runPlan.ok) return refused(step.name, 'run', runPlan.reason, performance.now() - started)
  const runResult = execute(step.name, 'run', runPlan, spawn)
  if (runResult.exitCode !== 0 || !step.verify) return stepOutcome(runResult, null)

  const verifyPlan = stepCommandPlan(step.verify, step.exec, context, step.name, 'verify')
  if (!verifyPlan.ok) {
    return refused(step.name, 'verify', verifyPlan.reason, performance.now() - started)
  }
  return stepOutcome(runResult, execute(step.name, 'verify', verifyPlan, spawn))
}

export function runUndo(step: Step, context: StepContext, spawn: Spawn = defaultSpawn): StepResult {
  const started = performance.now()
  if (!step.undo) {
    return refused(
      step.name,
      'undo',
      `step "${step.name}" declares no undo`,
      performance.now() - started,
    )
  }
  const plan = stepCommandPlan(step.undo, step.exec, context, step.name, 'undo')
  if (!plan.ok) return refused(step.name, 'undo', plan.reason, performance.now() - started)
  return stepOutcome(execute(step.name, 'undo', plan, spawn), null)
}
