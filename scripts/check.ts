import {
  decideRuntimeBudget,
  HUNG_SUITE_TIMEOUT_MS,
  SUITE_RUNTIME_BUDGET_MS,
} from './check-runtime'

type Command = { cwd: string; argv: string[] }
type Leg = { name: string; commands: Command[] }
type LegResult = { name: string; exitCode: number; tail: string[] }

const root = new URL('..', import.meta.url).pathname
const checkStartedAt = performance.now()

const activeChildren = new Set<Bun.Subprocess>()
let excludedGateWaitMs = 0
let runtimeDeadline: ReturnType<typeof setTimeout>

async function expireRuntimeBudget() {
  console.error(
    `suite runtime exceeded the ${(HUNG_SUITE_TIMEOUT_MS / 1000).toFixed(0)}s hung-suite limit`,
  )
  for (const child of activeChildren) child.kill('SIGTERM')
  await Bun.sleep(1_000)
  for (const child of activeChildren) child.kill('SIGKILL')
  process.exit(1)
}

function armRuntimeDeadline() {
  clearTimeout(runtimeDeadline)
  const deadline = checkStartedAt + HUNG_SUITE_TIMEOUT_MS + excludedGateWaitMs
  runtimeDeadline = setTimeout(expireRuntimeBudget, Math.max(0, deadline - performance.now()))
}

armRuntimeDeadline()

function track(child: Bun.Subprocess) {
  activeChildren.add(child)
  void child.exited.finally(() => activeChildren.delete(child))
  return child
}

const legs: Leg[] = [
  {
    name: 'orchestrator',
    commands: [
      { cwd: `${root}orchestrator`, argv: ['bun', 'install', '--silent'] },
      { cwd: `${root}orchestrator`, argv: ['bun', 'run', 'typecheck'] },
      // The unit gate runs once under the shared host-load hold.
      { cwd: `${root}orchestrator`, argv: ['bun', 'run', 'test:gate'] },
    ],
  },
  {
    name: 'hub',
    commands: [
      { cwd: `${root}hub`, argv: ['bun', 'install', '--silent'] },
      { cwd: `${root}hub`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}hub`, argv: ['bun', 'run', 'test'] },
    ],
  },
  {
    name: 'hub/web',
    commands: [
      { cwd: `${root}hub/web`, argv: ['bun', 'install', '--silent'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'test'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'build'] },
    ],
  },
]

async function inherit(argv: string[], cwd = root) {
  const child = track(Bun.spawn(argv, { cwd, stdout: 'inherit', stderr: 'inherit' }))
  return child.exited
}

function qualityBaseArgument() {
  if (!process.env.CI) return '--staged'
  const landingBranch = process.env.GITHUB_BASE_REF || 'main'
  const result = Bun.spawnSync(['git', 'merge-base', `origin/${landingBranch}`, 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(
      `quality ratchet could not resolve CI merge base with origin/${landingBranch}${detail ? `: ${detail}` : ''}`,
    )
  }
  return `--base=${result.stdout.toString().trim()}`
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  name: string,
  tail: string[],
  error: boolean,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) {
      const gateWait = name === 'orchestrator' && line.match(/^held (\d+)ms for host load /)
      if (gateWait) {
        excludedGateWaitMs += Number(gateWait[1])
        armRuntimeDeadline()
      }
      const prefixed = `[${name}] ${line}`
      ;(error ? console.error : console.log)(prefixed)
      tail.push(prefixed)
      if (tail.length > 40) tail.shift()
    }
  }
  pending += decoder.decode()
  if (pending) {
    const prefixed = `[${name}] ${pending}`
    ;(error ? console.error : console.log)(prefixed)
    tail.push(prefixed)
    if (tail.length > 40) tail.shift()
  }
}

async function runLeg(leg: Leg): Promise<LegResult> {
  const tail: string[] = []
  for (const command of leg.commands) {
    const child = track(
      Bun.spawn(command.argv, { cwd: command.cwd, stdout: 'pipe', stderr: 'pipe' }),
    )
    const readers = [
      pump(child.stdout, leg.name, tail, false),
      pump(child.stderr, leg.name, tail, true),
    ]
    const exitCode = await child.exited
    await Promise.all(readers)
    if (exitCode !== 0) return { name: leg.name, exitCode, tail }
  }
  return { name: leg.name, exitCode: 0, tail }
}

function refuseFailed(results: LegResult[]) {
  const failed = results.filter((result) => result.exitCode !== 0)
  if (!failed.length) return
  for (const result of failed) {
    console.error(`\n[${result.name}] failing leg tail (exit ${result.exitCode})`)
    for (const line of result.tail) console.error(line)
  }
  process.exit(1)
}

if ((await inherit(['bun', 'install', '--silent'])) !== 0) process.exit(1)

const installs = await Promise.all(
  legs.map((leg) =>
    runLeg({
      name: leg.name,
      commands: [leg.commands[0]!],
    }),
  ),
)
refuseFailed(installs)

if ((await inherit([`${root}node_modules/.bin/biome`, 'ci', '.'])) !== 0) process.exit(1)

if (
  (await inherit([
    // Every .githooks test must be named here. The list is explicit rather than a
    // glob so this runs in a fixed order before the legs, and the cost of that is
    // that an unnamed hook test is not gated at all - which reports safety it is
    // not providing.
    'bun',
    'test',
    './scripts/check-canon.test.ts',
    './scripts/check-runtime.test.ts',
    './scripts/check-comment-hygiene.test.ts',
    './scripts/check-test-placement.test.ts',
    './scripts/check-file-ceiling.test.ts',
    './scripts/check-cognitive-ceiling.test.ts',
    './scripts/import-scanner.test.ts',
    './scripts/check-import-cycles.test.ts',
    './scripts/quality/ratchet.test.ts',
    './scripts/quality/ceiling-decision.test.ts',
    './scripts/quality/test-timing-decision.test.ts',
    './shared/git.test.ts',
    './shared/orch-contract.test.ts',
    './shared/interval.test.ts',
    './shared/trackers-protocols.test.ts',
  ])) !== 0
)
  process.exit(1)

const results = await Promise.all(
  legs.map((leg) =>
    runLeg({
      name: leg.name,
      commands: leg.commands.slice(1),
    }),
  ),
)
refuseFailed(results)

for (const script of [
  'check-boundaries.ts',
  'check-schema-core-boundary.ts',
  'check-schema-docs-boundary.ts',
  'check-schema-review-boundary.ts',
  'check-schema-lens-boundary.ts',
  'check-schema-workflow-boundary.ts',
  'check-schema-port-boundary.ts',
  'check-isolation-boundary.ts',
  'check-review-boundary.ts',
  'check-review-coverage-boundary.ts',
  'check-review-pins-boundary.ts',
  'check-review-triage-boundary.ts',
  'check-review-calibration-boundary.ts',
  'check-review-evidence-sql-boundary.ts',
  'check-review-types-boundary.ts',
  'check-outcome-boundary.ts',
  'check-contract-boundary.ts',
  'check-evidence-boundary.ts',
  'check-git-environment-boundary.ts',
  'check-review-target-boundary.ts',
  'check-checkout-identity-boundary.ts',
  'check-worktree-mcp-boundary.ts',
  'check-worktree-template-boundary.ts',
  'check-worktree-attribution-boundary.ts',
  'check-project-lock-boundary.ts',
  'check-ref-guard-boundary.ts',
  'check-worktree-tool-boundary.ts',
  'check-worktree-remove-boundary.ts',
  'check-worktree-types-boundary.ts',
  'check-worktree-caller-boundary.ts',
  'check-worktree-preflight-boundary.ts',
  'check-worktree-create-boundary.ts',
  'check-worktree-readonly-boundary.ts',
  'check-run-claim-boundary.ts',
  'check-run-live-boundary.ts',
  'check-run-terminal-boundary.ts',
  'check-run-close-boundary.ts',
  'check-run-types-boundary.ts',
  'check-resume-tree-boundary.ts',
  'check-workflows-boundary.ts',
  'check-issue-report-fields-boundary.ts',
  'check-mcp-preflight-boundary.ts',
  'check-dispatch-preflight-boundary.ts',
  'check-failover-boundary.ts',
  'check-run-process-boundary.ts',
  'check-task-branch-boundary.ts',
  'check-prompt-retarget-boundary.ts',
  'check-run-artifacts-boundary.ts',
  'check-close-out-boundary.ts',
  'check-run-control-boundary.ts',
  'check-run-dispatch-boundary.ts',
  'check-run-answer-boundary.ts',
  'check-cleanup-boundary.ts',
  'check-cleanup-sweep-boundary.ts',
  'check-run-stop-boundary.ts',
  'check-judgement-boundary.ts',
  'check-recalibration-boundary.ts',
  'check-confinement-ruling-boundary.ts',
  'check-doc-commands-boundary.ts',
  'check-project-commands-boundary.ts',
  'check-doctor-boundary.ts',
  'check-port-commands-boundary.ts',
  'check-review-commands-boundary.ts',
  'check-dispatch-commands-boundary.ts',
  'check-canon-commands-boundary.ts',
  'check-routing-commands-boundary.ts',
  'check-failure-commands-boundary.ts',
  'check-health-commands-boundary.ts',
  'check-run-listing-boundary.ts',
  'check-run-inbox-boundary.ts',
  'check-run-diff-boundary.ts',
  'check-cli-boundary.ts',
  'check-agent-commands-boundary.ts',
  'check-epic-commands-boundary.ts',
  'check-job-commands-boundary.ts',
  'check-mcp-commands-boundary.ts',
  'check-metric-commands-boundary.ts',
  'check-monitor-commands-boundary.ts',
  'check-monitor-boundary.ts',
  'check-monitor-conditions-boundary.ts',
  'check-monitor-notices-boundary.ts',
  'check-monitor-types-boundary.ts',
  'check-database-boundary.ts',
  'check-store-hooks-boundary.ts',
  'check-review-vocabulary-boundary.ts',
  'check-review-coverage-match-boundary.ts',
  'check-process-liveness-boundary.ts',
  'check-clock-boundary.ts',
  'check-run-authority-boundary.ts',
  'check-evidence-query-boundary.ts',
  'check-resource-ownership-boundary.ts',
  'check-run-liveness-boundary.ts',
  'check-score-boundary.ts',
  'check-duel-boundary.ts',
  'check-capabilities-boundary.ts',
  'check-codex-schema-boundary.ts',
  'check-agent-registry-boundary.ts',
  'check-agent-probe-boundary.ts',
  'check-local-host-boundary.ts',
  'check-statistics-boundary.ts',
  'check-calibration-port-boundary.ts',
  'check-standard-calibration-boundary.ts',
  'check-standard-transports-boundary.ts',
  'check-runtime-registration-boundary.ts',
  'check-sandbox-boundary.ts',
  'check-codex-mcp-scope-boundary.ts',
  'check-module-boundaries.ts',
  'check-inversion-boundaries.ts',
  'check-git-environment-spawn.ts',
  'check-launchd-templates.ts',
  'check-gitleaks.ts',
  'check-write-transaction-site.ts',
  'check-file-ceiling.ts',
  'check-cognitive-ceiling.ts',
  'check-test-fixtures.ts',
  'check-test-placement.ts',
  'check-test-spawns.ts',
  'check-comment-hygiene.ts',
  'check-brand.ts',
  'check-canon.ts',
  '../orchestrator/scripts/check-pack-budget.ts',
  'check-import-cycles.ts',
]) {
  const child = track(
    Bun.spawn(['bun', `${root}scripts/${script}`], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  )
  if ((await child.exited) !== 0) process.exit(1)
}

let qualityMode: string
try {
  qualityMode = qualityBaseArgument()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
if ((await inherit(['bun', `${root}scripts/quality/check-no-expect.ts`, qualityMode])) !== 0) {
  process.exit(1)
}

const elapsedMs = performance.now() - checkStartedAt - excludedGateWaitMs
clearTimeout(runtimeDeadline)
console.log(
  `suite runtime: ${(elapsedMs / 1000).toFixed(2)}s / ${(SUITE_RUNTIME_BUDGET_MS / 1000).toFixed(0)}s budget`,
)
if (excludedGateWaitMs)
  console.log(`gate admission wait excluded: ${(excludedGateWaitMs / 1000).toFixed(2)}s`)
const runtimeBudgetVerdict = decideRuntimeBudget({
  elapsedMs,
  budgetMs: SUITE_RUNTIME_BUDGET_MS,
  ci: Boolean(process.env.CI),
})
if (runtimeBudgetVerdict === 'over-informational') {
  console.log(
    'suite runtime budget is informational locally because wall clock cannot separate a slower suite from a busier machine',
  )
}
if (runtimeBudgetVerdict === 'over-fatal') {
  console.error(
    `suite runtime budget exceeded by ${((elapsedMs - SUITE_RUNTIME_BUDGET_MS) / 1000).toFixed(2)}s`,
  )
  process.exit(1)
}
