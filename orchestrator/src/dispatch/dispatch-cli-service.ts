// concern: dispatch-commands
/** Owns dispatch composition across routing, transport, and run-dispatch ports. Must not know CLI grammar. */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS } from '../agent/agent-registry.ts'
import { resumePromptByteLimit } from '../agent/agents.ts'
import { ensureLocalHealth } from '../agent/model-host.ts'
import {
  resolveTaskBranch,
  type TaskBranchLandingRefusal,
  TaskBranchLandingRefusalError,
  taskBranchReuseNotice,
} from '../branch/task-branch.ts'
import { resolveCompatibleTaskBranch } from '../branch/task-branch-reuse.ts'
import { flagValue, flagValues, readMessageText } from '../cli/args.ts'
import { readStrictCodexSchema } from '../contract/codex-schema.ts'
import { contractConflicts } from '../contract/contract.ts'
import { nowIso, sessionId } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { JOBS, job } from '../jobs/jobs.ts'
import { effectiveMcpRequest, type McpRequest, requiredMcpServer } from '../mcp/mcp-preflight.ts'
import { projectAt, projectByName, stackAt } from '../project/projects.ts'
import { implicitReviewWarning } from '../review/review-target.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import type { DetachSpec } from '../route/failover.ts'
import { pick } from '../route/route.ts'
import { pickCommand } from '../route/routing-commands.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import { follow as followRun } from '../run/run-control.ts'
import { detach as dispatchDetached } from '../run/run-dispatch.ts'
import {
  assertAcpAllowed,
  assertAcpReady,
  resolveTransportName,
  selectAgentForTransport,
} from '../transport/transport.ts'
import {
  callerDrift,
  checkoutHasUncommittedWork,
  isWorktreeRelativeRef,
  resolveBase,
} from '../worktree/worktree-caller.ts'
import { dispatchCommand } from './dispatch-commands.ts'
import { callerCheckoutFacts } from './dispatch-preflight.ts'
import { lookupProjectTaskKey } from './task-key-lookup.ts'

type Presentation = {
  error(...values: unknown[]): void
  printRunId(id: number): void
  cwd(): string
}

type CallerCheckoutDecision = {
  callerCwd: string
  launchCwd: string
  notice: string | null
}

type DispatchLaunchCwdDecision = { checkoutCwd: string; refusal: null } | { refusal: string }

export function dispatchLaunchCwdDecision(input: {
  namedProject: { name: string; path: string } | null
  cwdWasGiven: boolean
  cwd: string
  cwdProject: { name: string } | null
}): DispatchLaunchCwdDecision {
  if (!input.namedProject) return { checkoutCwd: input.cwd, refusal: null }
  if (!input.cwdWasGiven) return { checkoutCwd: input.namedProject.path, refusal: null }
  if (!input.cwdProject || input.cwdProject.name === input.namedProject.name) {
    return { checkoutCwd: input.cwd, refusal: null }
  }
  return {
    refusal:
      `--repo names project ${input.namedProject.name}, but --cwd is inside project ` +
      `${input.cwdProject.name}; drop one of --repo or --cwd, or point --cwd inside ` +
      `project ${input.namedProject.name}`,
  }
}

function recordedLaunchCwdDecision(input: {
  shellCwd: string
  shellProject: { name: string } | null
  checkoutCwd: string
  checkoutProject: { name: string; path: string } | null
}): string {
  if (input.shellProject?.name === input.checkoutProject?.name) return input.shellCwd
  return input.checkoutProject?.path ?? input.shellCwd
}

export function callerCheckoutDecision(input: {
  recordedLaunchCwd: string
  explicitCwd: string | null
  repoRoot: string | null
  registeredProjectPath: string | null
  linkedWorktree: boolean
  borrowedCheckout: boolean
}): CallerCheckoutDecision {
  const callerCwd = input.explicitCwd ?? input.recordedLaunchCwd
  if (
    input.explicitCwd !== null ||
    input.repoRoot === null ||
    input.registeredProjectPath === null ||
    (!input.linkedWorktree && !input.borrowedCheckout)
  ) {
    return { callerCwd, launchCwd: input.recordedLaunchCwd, notice: null }
  }
  return {
    callerCwd: input.registeredProjectPath,
    launchCwd: input.recordedLaunchCwd,
    notice:
      `! dispatched from project tree ${input.recordedLaunchCwd}; caller checkout is ` +
      `${input.registeredProjectPath} (pass --cwd to choose a tree)`,
  }
}

export function resolveCallerCheckoutDecision(
  input: {
    shellCwd: string
    explicitCwd: string | null
    namedProject: { name: string; path: string } | null
    cwdProject: { name: string; path: string } | null
    shellProject: { name: string; path: string } | null
  },
  checkoutFactsAt: (cwd: string) => ReturnType<typeof callerCheckoutFacts>,
): CallerCheckoutDecision {
  const selection = dispatchLaunchCwdDecision({
    namedProject: input.namedProject,
    cwdWasGiven: input.explicitCwd !== null,
    cwd: input.explicitCwd ?? input.shellCwd,
    cwdProject: input.cwdProject,
  })
  if (!('checkoutCwd' in selection)) throw new Error(selection.refusal)
  const checkoutCwd = selection.checkoutCwd
  const decidedCwdIsExplicit = input.explicitCwd !== null || input.namedProject !== null
  const checkoutProject = input.explicitCwd
    ? input.cwdProject
    : (input.namedProject ?? input.shellProject)
  const facts = checkoutFactsAt(checkoutCwd)
  return callerCheckoutDecision({
    recordedLaunchCwd: recordedLaunchCwdDecision({
      shellCwd: input.shellCwd,
      shellProject: input.shellProject,
      checkoutCwd,
      checkoutProject,
    }),
    explicitCwd: decidedCwdIsExplicit ? checkoutCwd : null,
    ...facts,
  })
}

function resolveCallerCheckout(
  shellCwd: string,
  explicitCwd?: string,
  explicitRepo?: string,
): CallerCheckoutDecision {
  const selectedCwd = explicitCwd ? realpathSync(explicitCwd) : shellCwd
  return resolveCallerCheckoutDecision(
    {
      shellCwd,
      explicitCwd: explicitCwd !== undefined ? selectedCwd : null,
      namedProject: explicitRepo ? projectByName(explicitRepo) : null,
      cwdProject: explicitCwd ? projectAt(selectedCwd) : null,
      shellProject: projectAt(shellCwd),
    },
    callerCheckoutFacts,
  )
}

async function modelForDistinct(id: number): Promise<string> {
  const { db } = await import('../database/db.ts')
  const until = Date.now() + 5_000
  while (true) {
    const row = db().query('SELECT model, status FROM run WHERE id=?').get(id) as {
      model: string | null
      status: string
    } | null
    if (!row) throw new Error(`no run ${id} named by --distinct-from`)
    if (row.model) return row.model
    if (row.status !== 'running' || Date.now() >= until)
      throw new Error(`run ${id} recorded no model for --distinct-from to exclude`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function routeConstraints(
  argv: string[],
  agent?: string,
): Promise<{ avoid: string[]; distinctModels: string[] }> {
  const avoid = flagValue(argv, 'avoid')?.split(',').filter(Boolean) ?? []
  for (const name of avoid) if (!AGENTS[name]) throw new Error(`unknown agent "${name}" in --avoid`)
  const ids = agent
    ? []
    : (flagValue(argv, 'distinct-from')?.split(',').filter(Boolean) ?? []).map(Number)
  if (ids.some((id) => !Number.isInteger(id) || id <= 0))
    throw new Error('--distinct-from expects comma-separated run ids')
  if (agent && avoid.includes(agent))
    throw new Error(`--agent ${agent} contradicts --avoid ${agent}`)
  return { avoid, distinctModels: await Promise.all(ids.map(modelForDistinct)) }
}

function requestedMcp(argv: string[]): McpRequest | undefined {
  const values = argv.filter((arg) => arg === '--mcp' || arg.startsWith('--mcp='))
  if (values.length > 1) throw new Error('--mcp may be supplied only once')
  if (!values.length) return undefined
  return values[0] === '--mcp=prefer' ? 'prefer' : 'require'
}

function warnCallerDrift(
  cwd: string,
  baseRef: string | undefined,
  error: (...values: unknown[]) => void,
): void {
  const drift = callerDrift(cwd, baseRef)
  if (!drift) return
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        sessionId() ?? 'no-session',
        realpathSync(cwd),
        drift.callerHead,
        drift.base,
      ]),
    )
    .digest('hex')
  try {
    mkdirSync(join(RUNS_DIR, '.signals'), { recursive: true })
    writeFileSync(join(RUNS_DIR, '.signals', `caller-drift-${key}`), '', { flag: 'wx' })
  } catch {
    return
  }
  error(
    `! caller checkout HEAD ${drift.callerHead} is behind or diverged from ${drift.baseRef} (${drift.base}).\n  Update the caller checkout; repository runs from it are still dispatched.`,
  )
}

export function taskBranchLandingBypassWarning(
  key: string,
  base: string,
  refusal: TaskBranchLandingRefusal,
): string {
  if (refusal.cause === 'closed-unmerged') {
    return (
      `! task branch for ${key} has closed-unmerged pull request ` +
      `#${refusal.pullRequest}; explicit --base ${base} is used as given`
    )
  }
  return (
    `! task-branch landing check for ${key} did not complete (${refusal.reason}); ` +
    `explicit --base ${base} is used as given`
  )
}

function warnTaskBranchBypass(
  cwd: string,
  key: string | null,
  base: string | undefined,
  error: (...values: unknown[]) => void,
): void {
  if (!key || !base) return
  // Best effort: --base is how a caller escapes an ambiguous or unresolvable
  // task branch, so failing to name the bypassed branch must not refuse it.
  let candidate: ReturnType<typeof resolveTaskBranch>
  try {
    candidate = resolveTaskBranch(cwd, key)
  } catch (cause) {
    if (cause instanceof TaskBranchLandingRefusalError) {
      error(taskBranchLandingBypassWarning(key, base, cause.refusal))
      return
    }
    const reason = String((cause as Error)?.message ?? cause).split('\n', 1)[0]
    error(`! explicit --base bypasses task-branch reuse for ${key}; ${reason}`)
    return
  }
  if (!candidate) return
  error(
    `! explicit --base bypasses task branch ${candidate.branch} at tip ${candidate.tip} ` +
      `(${candidate.commitCount} ${candidate.commitCount === 1 ? 'commit' : 'commits'}); ` +
      `once this run is recorded it supersedes that branch for ${key}.`,
  )
}

function resolveTaskBranchForDispatch(
  cwd: string,
  key: string,
  reportReuse: boolean,
  error: (...values: unknown[]) => void,
): ReturnType<typeof resolveTaskBranch> {
  const candidate = resolveCompatibleTaskBranch(cwd, key, sessionId())
  if (candidate && reportReuse) error(taskBranchReuseNotice(candidate))
  return candidate
}

const scoreSuffix = (jobName: string) =>
  (JOBS[jobName]?.needs.writesRepo ? ' [drifted|partial|faithful]' : '') +
  (JOBS[jobName]?.findings
    ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`
    : '')
const scoreHint = (id: number, jobName: string, parent: number | null) =>
  `orch score ${parent ?? id} <none|partial|full> [wrong|mixed|right]${scoreSuffix(jobName)} --note "..."${parent ? `   # the whole conversation, not turn ${id}` : ''}`
const duration = (ms: number | null | undefined) => {
  if (ms == null) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
const argvResumeLimit = (agentName: string) =>
  AGENTS[agentName]?.resumeArgv ? resumePromptByteLimit(AGENTS[agentName]!) : undefined

export async function doCommand(argv: string[], presentation: Presentation): Promise<void> {
  await ensureLocalHealth()
  const flag = (name: string) => flagValue(argv, name)
  const has = (name: string) =>
    argv.includes(`--${name}`) || argv.some((arg) => arg.startsWith(`--${name}=`))
  const values = (name: string) => flagValues(argv, name)
  const positional = argv.slice(2).filter((value, index, rest) => {
    const consuming = new Set([
      '--agent',
      '--file',
      '--schema',
      '--model',
      '--transport',
      '--seed',
      '--key',
      '--repo',
      '--base',
      '--review',
      '--avoid',
      '--distinct-from',
      '--label',
      '--lens',
      '--deliverable',
      '--timeout',
      '--cwd',
    ])
    return !consuming.has(rest[index - 1] ?? '') && !value.startsWith('--')
  })
  const prompt = async () =>
    (await readMessageText({
      missing: 'no prompt: pass it as an argument, via --file, or on stdin',
      optional: Boolean(JOBS[argv[1] ?? '']?.findings && flag('lens')),
      sources: { commandFile: flag('file'), positionals: positional },
    })) ?? ''
  const resolveOptions = async (jobName: string) => {
    const selected = flag('agent') ? AGENTS[flag('agent')!] : undefined,
      transportFlag = flag('transport'),
      explicit = transportFlag !== undefined || Boolean(process.env.ORCH_TRANSPORT),
      transport =
        !explicit && selected ? selected.defaultTransport : resolveTransportName(transportFlag)
    if (transport === 'acp') {
      assertAcpAllowed(jobName, flag('agent'), selected)
      assertAcpReady(flag('agent') ?? 'codex', selected)
    }
    return {
      agent: selectAgentForTransport(transport, flag('agent')),
      transport,
      transportExplicit: explicit,
      ...(await routeConstraints(argv, flag('agent'))),
      mcp: requestedMcp(argv),
    }
  }
  const detach = async (jobName: string, text: string, spec: DetachSpec) => {
    let selected: string | undefined
    const mcpRequest = effectiveMcpRequest(spec.mcp, job(jobName))
    if (!spec.resume && mcpRequest)
      selected = pick(
        jobName,
        spec.agent,
        text.length,
        true,
        stackAt(spec.cwd ?? presentation.cwd()),
        {
          agents: spec.avoid,
          models: spec.distinctModels,
          model: spec.model,
          requiredMcp: requiredMcpServer(mcpRequest, spec.cwd ?? presentation.cwd(), spec.repo),
        },
        spec.probe,
        spec.lens,
      ).agent
    return dispatchDetached(jobName, text, spec, selected)
  }
  await dispatchCommand(
    argv,
    { has, flag, values },
    {
      usage: (): never => {
        throw new Error('orch do <job> [prompt]')
      },
      doUsage: (): never => {
        throw new Error('orch do <job> [prompt]')
      },
      error: presentation.error,
      printRunId: presentation.printRunId,
      readPrompt: prompt,
      validateSchema: readStrictCodexSchema,
      warnCallerDrift: (cwd, base) => warnCallerDrift(cwd, base, presentation.error),
      warnTaskBranchBypass: (cwd, key, base) =>
        warnTaskBranchBypass(cwd, key, base, presentation.error),
      resolveTaskBranchForDispatch: (cwd, key, reportReuse) =>
        resolveTaskBranchForDispatch(cwd, key, reportReuse, presentation.error),
      contractConflicts,
      warnImplementContractConflicts: (conflicts, id) => {
        if (!conflicts.length) return
        presentation.error(
          '! implement spec may conflict with its no-push/no-merge/no-rewrite contract:',
        )
        for (const conflict of conflicts)
          presentation.error(`  line ${conflict.line}: ${conflict.text}`)
        presentation.error(
          `  The spec was not changed. Run ${id} has started; review the spec before the worker reaches this conflict.`,
        )
      },
      checkoutHasUncommittedWork,
      resolveBase,
      isWorktreeRelativeRef,
      implicitReviewWarning,
      resolveCallerCheckout: (cwd, repo) => resolveCallerCheckout(presentation.cwd(), cwd, repo),
      resolveDispatchOptions: resolveOptions,
      lookupTaskKey: async (project, key) => {
        const registered = projectByName(project)
        if (!registered) {
          return { state: 'unreachable', condition: `project ${project} is not registered` }
        }
        return lookupProjectTaskKey(registered, key)
      },
      recordRunWarning: (runId, warning) =>
        appendRunEvent(runId, { ts: nowIso(), type: 'text', text: warning }),
      detach,
      follow: (id, quiet) =>
        followRun(id, quiet, true, {
          dur: duration,
          scoreHint,
          argvResumeLimit,
          printRunId: presentation.printRunId,
        }),
    },
  )
}

export async function pickPreviewCommand(
  argv: string[],
  presentation: Presentation & { log(value: string): void },
): Promise<void> {
  await ensureLocalHealth()
  const flag = (name: string) => flagValue(argv, name),
    jobName = argv[1]!
  if (job(jobName).needs.readsRepo)
    warnCallerDrift(presentation.cwd(), undefined, presentation.error)
  const transport = resolveTransportName(flag('transport'))
  if (transport === 'acp')
    assertAcpAllowed(jobName, flag('agent'), flag('agent') ? AGENTS[flag('agent')!] : undefined)
  pickCommand(
    {
      jobName,
      stack: flag('stack') ?? stackAt(presentation.cwd()),
      ...(await routeConstraints(argv, flag('agent'))),
      lens: flag('lens'),
      selectedAgent: selectAgentForTransport(transport, flag('agent')),
    },
    { has: (name) => argv.includes(`--${name}`), flag },
    { log: presentation.log, agents: AGENTS },
  )
}
