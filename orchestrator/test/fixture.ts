/** Shared test state and helpers. The preload establishes ORCH_DB before this module imports src. */
import { afterEach, beforeEach, expect } from 'bun:test'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchRunEnvelopeSchema } from '../../shared/orch-contract.ts'
import type { WorktreeCreate, WorktreeCreateArg } from '../src/projects.ts'
import { PRELOAD_RUNS, PRELOAD_STORE, REGISTERED_LIVE_STORE } from './preload.ts'
/**
 * Everything below treats the store's directory as scratch: a git repository is
 * initialised in it, a fake docker is written into it, worktrees are cut under
 * it. On 2026-09-07 a test leg ran without the preload while ORCH_DB named the
 * live store, so this module initialised a repository inside the main
 * checkout's orchestrator/ and the suite wrote the live database. The preload
 * refuses that; this module is imported directly by tests and refuses it too.
 */
function ownedScratchDirectory(): string {
  const named = process.env.ORCH_DB
  const scratch = named ? dirname(named) : null
  let real: string | null = null
  try { real = scratch ? realpathSync(scratch) : null } catch { real = null }
  const owned = real !== null
    && real.startsWith(`${realpathSync(tmpdir())}/`)
    && real.split('/').pop()!.startsWith('orch-test-')
  if (!owned) {
    throw new Error(
      `test fixture refuses to run: ORCH_DB is ${named ?? 'unset'}, not a store the test preload minted under ${tmpdir()}\n` +
      'invariant: A test suite only ever writes a store its own preload created.\n' +
      'cleared by: bun test from orchestrator/ with ORCH_DB unset',
    )
  }
  return scratch!
}
const dir = ownedScratchDirectory()
export { dir }

function childEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  const requestedStore = env?.ORCH_DB ?? PRELOAD_STORE
  if (resolve(requestedStore) === REGISTERED_LIVE_STORE) {
    throw new Error(`test child refuses registered live store: ${REGISTERED_LIVE_STORE}`)
  }
  return {
    ...(env ?? process.env),
    ORCH_DB: requestedStore,
    ORCH_RUNS: env?.ORCH_RUNS ?? PRELOAD_RUNS,
  }
}

const testSpawn: typeof Bun.spawn = ((cmd: any, options: any = {}) =>
  Bun.spawn(cmd, { ...options, env: childEnv(options.env) })) as typeof Bun.spawn
const testSpawnSync: typeof Bun.spawnSync = ((cmd: any, options: any = {}) =>
  Bun.spawnSync(cmd, { ...options, env: childEnv(options.env) })) as typeof Bun.spawnSync
export const declaredCreate = (command: string, args: WorktreeCreateArg[]): WorktreeCreate =>
  ({ command, args })

export const runJson = (line: string) =>
  OrchRunEnvelopeSchema.parse(JSON.parse(line)).data as Record<string, any>

// Some lifecycle tests need compound shell setup in a scratch repository. The
// production registration path refuses this shape; these tests bypass the
// register deliberately because the compound script is their fixture.
export const compoundCreate = (script: string): WorktreeCreate =>
  ({ command: 'sh', args: ['-c', script] })

export const gitEnvironmentVariables = Object.keys(process.env).filter((variable) =>
  variable.startsWith('GIT_'))
export async function runWithDelayedStdoutReader(
  argv: string[], env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const pipeDir = mkdtempSync(join(tmpdir(), 'orch-slow-stdout-'))
  const fifo = join(pipeDir, 'stdout.fifo')
  const made = testSpawnSync(['mkfifo', fifo], { stdout: 'pipe', stderr: 'pipe' })
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  try {
    // fd 3 is opened before the sleep, so the producer starts against a pipe
    // whose consumer deliberately does not read until its buffer is full.
    const reader = testSpawn(
      ['sh', '-c', 'exec 3<"$1"; sleep 0.25; cat <&3', 'slow-reader', fifo],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const writer = openSync(fifo, 'w')
    const producer = testSpawn(argv, { env, stdout: writer, stderr: 'pipe' })
    closeSync(writer)
    const [exitCode, stdout, stderr, readerExit, readerError] = await Promise.all([
      producer.exited,
      new Response(reader.stdout).arrayBuffer(),
      new Response(producer.stderr).text(),
      reader.exited,
      new Response(reader.stderr).text(),
    ])
    if (readerExit !== 0) throw new Error(readerError || `slow reader exited ${readerExit}`)
    return { exitCode, stdout: Buffer.from(stdout), stderr }
  } finally {
    rmSync(pipeDir, { recursive: true, force: true })
  }
}
export const hermeticGitCommand =
  `env ${gitEnvironmentVariables.map((variable) => `-u ${variable}`).join(' ')} git`
export const originalTestSandbox = process.env.ORCH_SANDBOX
// Existing fake-agent integration tests write capture artifacts outside their
// disposable trees. Profile construction and live SRT behaviour have dedicated
// coverage; these tests exercise their original subject on the host seam.
process.env.ORCH_SANDBOX = 'host'
export const hermeticHome = join(dir, 'home')
mkdirSync(hermeticHome)
export const { scrubbedGitEnv, targetGitEnvironment } = await import('../src/worktree.ts')
export const { mainCheckoutOf } = await import('../../shared/git.ts')

// A worker routes git objects and ref hooks into its own linked-worktree metadata.
// None of that routing belongs to the scratch repositories built by this test process.
export const hermeticGitEnv = (extra: Record<string, string> = {}) => ({
  ...scrubbedGitEnv(),
  HOME: hermeticHome,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  ...extra,
})
export const originalTestPath = process.env.PATH
export const cleanDockerBin = join(dir, 'clean-docker-bin')
mkdirSync(cleanDockerBin, { recursive: true })
writeFileSync(join(cleanDockerBin, 'docker'), '#!/bin/sh\nexit 0\n')
chmodSync(join(cleanDockerBin, 'docker'), 0o755)
process.env.PATH = `${cleanDockerBin}:${originalTestPath ?? ''}`
writeFileSync(join(dir, '.gitignore'), '*\n!.gitignore\n')
for (const args of [
  ['init', '-b', 'main'],
  ['config', 'user.email', 'orch-test@example.invalid'],
  ['config', 'user.name', 'Orch Test'],
  ['add', '.gitignore'],
  ['commit', '-m', 'test fixture'],
]) {
  const p = testSpawnSync(['git', ...args], {
    cwd: dir, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
}

export const { db, DB_PATH, nowIso, reapStale, pendingForSession, unscoredCount, judgeability, STALE_AFTER_MS,
        PENDING_BOOTSTRAP_MS, WEIGHT, weigh, label, FIDELITY_PENALTY, UNSCORED_WHERE,
        EVIDENCE_CLOSED_SQL, EVIDENCE_OPEN_SQL, VOIDED_SQL, voidedSql, activeSql, SCORED_EVIDENCE_SQL, runTotals,
        excludeSharedOutputRuns, SHARED_OUTPUT_REASON, applySchema, recordDuels, duelMatrices,
        pairPartners, unrecordedPairsForSession,
        parseRunIds, recordSessionSeen, GENERIC_QUESTION_TOKENS,
        bootstrapFixtureStore, authorizeRunMutation, adoptRunMutation, sessionId } = await import('../src/db.ts')
export const { candidates, weightCase, scoreboard, median, evidenceFor, pick,
        NOISE_BAND, QUALITY_STEP, MIN_SAMPLE, OUTPUT_RESERVE, EVIDENCE_WINDOW,
        STANDING_EXPLORE_RATE, STANDING_EXPLORE_FLOOR, standingExploreRate,
        PROMPT_SIZE_BOUNDARY, promptSizeBucket, betaContribution,
        BETA_SCALE, POSTERIOR_NOISE_BAND, currentPolicySelection } = await import('../src/route.ts')
export const { guide } = await import('../src/guide.ts')
export const { validateCliArgs } = await import('../src/args.ts')
export const { bradleyTerry, gwetAc1 } = await import('../src/agreement.ts')
export const { routingBacktest, routingBacktestEnsemble, ROUTING_BACKTEST_SEEDS } = await import('../src/routing-backtest.ts')
export const { projects, projectAt, projectByName, stackAt, upsertProject, removeProject } = await import('../src/projects.ts')
export const {
  missingDatabaseMessage, registeredRepositoryMissingDatabase, resolveDatabase, resolveRunsDirectory,
} = await import('../src/database-location.ts')
export const { dbNameFor, recipeNotes, runRecipe, fill } = await import('../src/recipe.ts')
export const {
  JOBS, jobBoundInstructionForContract, resolveJobTimeoutMs, jobTimeoutCeilingMinutes,
  isReaderJob, READER_JOBS, JOB_TIMEOUTS,
} = await import('../src/jobs.ts')
export const { runDetail, runList, state } = await import('../src/serve.ts')
export const { classify, NEEDS_HUMAN, NEEDS_HUMAN_TITLE, NOT_EVIDENCE, COOLS_DOWN, FAILS_OVER,
        isNonAnswer, detectBlockers } = await import('../src/failure.ts')
export const { errorTail, preflight, preflightMcp, detachedRunOptions, runFilePaths, pruneRuns, KEEP_RUN_FILES_DAYS,
        RUNS_DIR, grokMcpConnection, assertGrokTrustEligible, writingFailoverRefusal, resolveSupersededTurn,
        resolveRootFromLastTurn, gitObjectEnvironmentFor, inferredReadOnlyKey,
        canonSourceFor, canonSourceInstruction, snapshotRegisteredCheckouts,
        checkoutAliases, checkoutCaseSensitivity,
        resolveTaskBranch, taskBranchCandidacySql,
        retargetRepositoryPrompt, retargetRepositoryPromptForDispatch,
        packedResumePrompt, resolveReviewTarget, implicitReviewWarning, mcpRequestFromStored,
        retryModelForAgent, run: runJob, listRunArtifacts, runArtifactsDir, runScratchDir,
        noRepoIsolatePath,
        readDispatchState, persistTerminalSnapshot, reconcileRun, closeOutRun,
        verifiedProcessTree, installTestProcessInventory, WORKTREE_LIVE_MS } = await import('../src/run.ts')
export const run = runJob
export const {
  CANON_EVALS, CANON_EVAL_LENS, TRACKED_EVAL_PATH, UNTRACKED_EVAL_PATH,
  runCanonEvals, canonEvalsReport, currentCanonEvalSha, failingCanonEvalSlugs, lastCanonEvalAt,
} = await import('../src/evals.ts')
export const retargetedPrompt = (
  prompt: string, callers: string | string[], worktree: string,
  caseInsensitive = false, protectedWorktreeRoots: string[] = [],
) => retargetRepositoryPrompt(
  prompt, callers, worktree, caseInsensitive, protectedWorktreeRoots,
).prompt
export const { summary } = await import('../src/metric.ts')
export const { parseWorkerReply, parseWorkerReplyWithCount, READONLY_PREAMBLE,
        NO_REPO_PREAMBLE, WORKER_PREAMBLE, LAND_PREAMBLE, REVIEW_SCHEMA,
        READER_SCHEMA, parseReaderOutput, missingDeclaredDeliverables, UNEVIDENCED_DELIVERABLE_ERROR,
        READER_DELIVERABLE_FIRST, readerDeliverablesInstruction,
        REVIEW_SEVERITY_INSTRUCTION, REVIEW_PROVENANCE_INSTRUCTION,
        INFRASTRUCTURE_RECOVERY, COULD_NOT_VERIFY_INSTRUCTION,
        VERIFY_CLAIM_SCHEMA, ISSUE_WORKER_SCHEMA, workerPreamble, workerResumeGuard,
        TEXT_REPLY_SCHEMA, TEXT_REPLY_SCHEMA_NAME, replyFileInstruction, rulingPrompt,
        packResumePrompt, contractConflicts,
        hasRealQuestions, realQuestions } = await import('../src/contract.ts')
export const { cleanReviewEvidence, parseReviewReply, recordReview, recordReviews, gradeReviewLens, reviewPins, coverageAudit,
        triageFinding, completeReview, getReview, listReviews, reviewCalibration,
        reviewCalibrationFleet, calibrationLine,
        MIN_REVIEW_TRIAGED } = await import('../src/review.ts')
export const { ask } = await import('../src/ask.ts')
export const { checkMessages, messageArchitect, messagesForRun } = await import('../src/mailbox.ts')
export const { orphanSafety, repoRootOf, createWorktree, createWorktreeForBranch, createWithTool, createReadOnlyWorktree,
        createReadOnlyWithTool, resolveBase, fillTool,
        seedArgv, createArgv, worktreeGitDir, prepareWorktreeObjects, prepareSharedRefGuard,
        assertSharedRefGuardOutsideWritableRoots, removeSharedRefGuard,
        workerSharedGitRoots,
        carryWorkingState, withWorktreeCreateLock, withProjectLock, projectLockState,
        reclaimStaleProjectLock, processStartTime, projectLockDir, staleProjectLockHolder,
        worktreeLeaseName,
        unmergedBranch, assertCallerAncestry, checkoutHasUncommittedWork, callerDrift,
        changesIn, contentTree, removeFor, branchTip } = await import('../src/worktree.ts')
export const { drainQueue, gateFailureSummary, land, landingStatus, landingReviewCoverage, resolveLandingBranch,
        setPostLandMigrateForFixture, landingsWithPostStepError, allocateLandingJournals,
        cleanCompletedSequencerState } = await import('../src/landing.ts')
export const { gitLocks, formatGitLocks } = await import('../src/git-locks.ts')
export const { AGENTS, ARGV_PROMPT_BYTES, localReachable, ensureLocalHealth, resetLocalHealth,
        unavailableReason, available, NEEDS_HEALTH, wakeDecision,
        WAKE_COOLDOWN_MS, CODEX_EXEC_SANDBOX, CODEX_ASK_ENV_VARS, strictCodexSchema } = await import('../src/agents.ts')
export const { listDocs, listDocMetadata, getDoc, setDoc: writeDoc, consumeDoc: consumeDocument, removeDoc: deleteDoc,
        docsForRun, exportDocs, importDocs: readDocs, brief, docSubjects,
        listOpenResumes, parseResumeFrontmatter, resumeAge, listDocRevisions, getDocRevision, restoreDoc,
        diffDocRevisions } =
  await import('../src/docs.ts')
export type TestDocInput = Parameters<typeof writeDoc>[0]
export const setDoc = (input: Omit<TestDocInput, 'reason'> & { reason?: string }) =>
  writeDoc({ ...input, reason: input.reason ?? 'test write' })
export const consumeDoc = (
  scope: string, subject: string | null, slug: string,
  context: { reason: string; author?: string } = { reason: 'test consume' },
) => consumeDocument(scope, subject, slug, context)
export const removeDoc = (
  scope: string, subject: string | null, slug: string,
  context: { reason: string; author?: string } = { reason: 'test delete' },
) =>
  deleteDoc(scope, subject, slug, context)
export const importDocs = (dir: string, context = { reason: 'test import' }) => readDocs(dir, context)
export const { createDocsMcpServer, fileIssue } = await import('../src/mcp.ts')
export const { setWorkflow, promoteWorkflow } = await import('../src/workflows.ts')
export const { compilePack, compileBrief, checkDoc, CanonBudgetError, recordPack, diffPack,
        allInjectChecks, allNumericLiterals, numericLiteralReport } = await import('../src/canon.ts')
export const { claimMonitorNotices, markMonitorNoticesDelivered, deadRunningProcessConditions, reconcileHub, rulingConditions, monitorHistory, monitor, formatMonitorPass, displayConditions } =
  await import('../src/monitor.ts')
export const { listPairs, addPair, baselineForPair, setBaseline, listSkips, addSkip,
        setLedgerRef, ledgerRef, listLedgerRefs, resolveLedgerRef,
        listDoctrineRules, addDoctrineRule, retireDoctrineRule } =
  await import('../src/porting.ts')
export const { applyImport, ImportRefusalError, planImport, sourceCoverage } = await import('../src/porting-import.ts')
export const { parseFiledIssue, seedFromReport, boundedIssuePack, parseIssueReply,
        validatedTrackerTaskKey, ISSUE_DIAGNOSIS_SCHEMA } = await import('../src/issue.ts')

/** Insert a finished run. Returns its id. */
export function addRun(o: {
  agent: string; job: string; status?: string; latency?: number; probe?: number
  kind?: string; parent?: number; turn?: number; session?: string | null; stack?: string
  model?: string; startedAt?: string
  lens?: string; repo?: string; inputTree?: string
  headCommit?: string
  promptBytes?: number
  promptSha?: string
  specSha?: string
}): number {
  return (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, spec_sha, prompt_bytes, prompt_head,
                      status, latency_ms, probe, failure_kind, parent_run_id, turn, session_id, stack,
                      model, lens, repo, input_tree, head_commit)
     VALUES (?,?,?,?,?,?,'head',?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    o.startedAt ?? new Date().toISOString(), o.agent, o.job, o.promptSha ?? 'sha',
    o.specSha ?? o.promptSha ?? 'spec', o.promptBytes ?? 10,
    o.status ?? 'ok', o.latency ?? 1000, o.probe ?? 0, o.kind ?? null,
    o.parent ?? null, o.turn ?? 1, o.session ?? null, o.stack ?? null,
    o.model ?? AGENTS[o.agent]?.model ?? null, o.lens ?? null, o.repo ?? null,
    o.inputTree ?? null, o.headCommit ?? null,
  ) as { id: number }).id
}

export function fakeDocker(containers: string[], volumes: string[]): { dir: string; env: Record<string, string> } {
  const fakeDir = mkdtempSync(join(tmpdir(), 'orch-fake-docker-'))
  const script = join(fakeDir, 'docker')
  writeFileSync(script, `#!/bin/sh
case "$1 $2" in
  "ps -a") printf '%s\\n' "$FAKE_DOCKER_CONTAINERS" ;;
  "volume ls") printf '%s\\n' "$FAKE_DOCKER_VOLUMES" ;;
  *) exit 9 ;;
esac
`)
  chmodSync(script, 0o755)
  return {
    dir: fakeDir,
    env: {
      PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
      FAKE_DOCKER_CONTAINERS: containers.join('\n'),
      FAKE_DOCKER_VOLUMES: volumes.join('\n'),
    },
  }
}

export function fakeDockerCommand(body: string): { dir: string; env: Record<string, string> } {
  const fakeDir = mkdtempSync(join(tmpdir(), 'orch-fake-docker-command-'))
  const script = join(fakeDir, 'docker')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return { dir: fakeDir, env: { PATH: `${fakeDir}:${process.env.PATH ?? ''}` } }
}

export const reviewReply = (findings = 1, severity = 'major') => ({
  findings: Array.from({ length: findings }, (_, i) => ({
    severity, location: `file.ts:${i + 1}`, evidence: `evidence ${i + 1}`,
    proposed_correction: `fix ${i + 1}`,
  })),
  provenance: {
    tree_inspected: 'abc123', standards_read: ['AGENTS.md'], model_used: 'reported-by-reviewer',
    files_covered: ['file.ts'], commands_run: ['bun test'], mcp_tools: [], docs_read: [],
    could_not_verify: [], substitutes: [],
    canon_source: 'live database' as const,
  },
})

export function score(
  runId: number, delivery: string, quality: string | null = null, fidelity: string | null = null,
) {
  db().query(
    'INSERT INTO score (run_id, delivery, quality, fidelity, scored_at) VALUES (?,?,?,?,?)',
  ).run(runId, delivery, quality, fidelity, new Date().toISOString())
}

export function workerReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'done', summary: 'done', files_changed: ['changed.ts'], questions: null,
    deviations: null, tests: { command: 'bun test', ran: true, passed: true, detail: null },
    blockers: null, ...overrides,
  }
}

export function landingDescribeFixture() {
let landingFixtureRunId = 50_000
  const landingModule = new URL('../src/landing.ts', import.meta.url).href
  const gitLocksModule = new URL('../src/git-locks.ts', import.meta.url).href
  const worktreeModule = new URL('../src/worktree.ts', import.meta.url).href
  const g = (cwd: string, ...args: string[]) => {
    const p = testSpawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const repoWithBranches = (branches: string[]) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-land-')))
    g(repo, 'init', '-b', 'main')
    g(repo, 'config', 'user.email', 'orch-test@example.invalid')
    g(repo, 'config', 'user.name', 'Orch Test')
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'trees/\n.orch-run\n')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    g(repo, 'add', 'base.txt')
    g(repo, 'commit', '-m', 'base')
    const trees: Record<string, string> = {}
    for (const branch of branches) {
      const tree = join(repo, 'trees', branch)
      mkdirSync(join(repo, 'trees'), { recursive: true })
      g(repo, 'worktree', 'add', '-b', branch, tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `${landingFixtureRunId++}\n${repo}\nsource: git\n`)
      writeFileSync(join(tree, `${branch}.txt`), `${branch}\n`)
      g(tree, 'add', `${branch}.txt`)
      g(tree, 'commit', '-m', branch)
      trees[branch] = tree
    }
    return { repo, trees }
  }
  const childLand = (
    repo: string, branch: string,
    options: { message?: string; unreviewed?: string | null; runId?: number } = {},
    extraEnv: Record<string, string | undefined> = {},
  ) => {
    const env: Record<string, string | undefined> = {
      ...hermeticGitEnv(), ...extraEnv,
      ORCH_DB: process.env.ORCH_DB!, CLAUDE_CODE_SESSION_ID: branch,
    }
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete env[name]
    }
    return testSpawn(
      [process.execPath, '-e',
        `const { land } = await import(process.argv[1]); land(process.argv[2], process.argv[3], JSON.parse(process.argv[4]))`,
        landingModule, repo, branch, JSON.stringify(options.unreviewed === null
          ? { ...options, unreviewed: undefined }
          : { unreviewed: 'existing landing fixture', ...options })],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
  }
  const observeGitLocks = (repo: string) => {
    // Bun's implicit spawn environment is the process launch environment, even
    // after process.env entries are deleted. Run the production observers in a
    // scrubbed child so an orch worker's private object store cannot replace the
    // scratch repository's object store.
    const child = testSpawnSync(
      [process.execPath, '-e', [
        'const { landingStatus } = await import(process.argv[1])',
        'const { gitLocks } = await import(process.argv[2])',
        'console.log(JSON.stringify({ status: landingStatus(process.argv[3]), locks: gitLocks(process.argv[3]) }))',
      ].join(';'), landingModule, gitLocksModule, repo],
      { cwd: repo, env: hermeticGitEnv({ ORCH_DB: process.env.ORCH_DB! }),
        stdout: 'pipe', stderr: 'pipe' },
    )
    if (child.exitCode !== 0) throw new Error(child.stderr.toString())
    return JSON.parse(child.stdout.toString()) as {
      status: string
      locks: ReturnType<typeof gitLocks>
    }
  }
  const completedReview = (
    project: string, trees: (string | null)[],
    source?: { branch: string; baseCommit: string; launchCwd: string },
  ) => {
    const entries = trees.map((tree, i) => ({
      runId: addRun({ agent: 'codex', job: 'review-lens', model: 'test',
        lens: `lens-${i + 1}`, repo: project, ...(tree ? { inputTree: tree } : {}) }),
      output: reviewReply(0),
    }))
    if (source) {
      const update = db().query(
        'UPDATE run SET branch=?, base_commit=?, launch_cwd=?, head_commit=? WHERE id=?',
      )
      const headCommit = g(source.launchCwd, 'rev-parse', 'HEAD^{commit}')
      for (const entry of entries) {
        update.run(source.branch, source.baseCommit, source.launchCwd, headCommit, entry.runId)
      }
    }
    const id = recordReviews(entries)
    completeReview(id)
    return id
  }

  const realTimeoutGate = (name: string) => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-real-timeout-gate-'))
    const testFile = join(fixture, 'buried-timeout.test.ts')
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
    writeFileSync(testFile, [
      "import { test } from 'bun:test'",
      `test(${JSON.stringify(name)}, async () => { await Bun.sleep(50) }, 1)`,
      "for (let i = 1; i <= 900; i++) test(`later test ${i}`, () => {})",
    ].join('\n') + '\n')
    return { fixture, gate: `${quote(process.execPath)} test ${quote(testFile)}` }
  }
  return { landingFixtureRunId, landingModule, gitLocksModule, worktreeModule, g, repoWithBranches, childLand, observeGitLocks, completedReview, realTimeoutGate }
}

export function runCollectionDescribeFixture() {
const CLI = new URL('../src/cli.ts', import.meta.url).pathname
  const orchInput = (args: string[], stdin?: string | Uint8Array, extraEnv: Record<string, string> = {}) => {
    const p = testSpawnSync([process.execPath, CLI, ...args], {
      // The suite may itself be run by an orch worker. CLI behavior under test
      // starts at the user boundary, not at the inherited delegation depth.
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ...extraEnv,
      },
      stdin: stdin === undefined ? undefined
        : typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin,
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const orch = (...args: string[]) => orchInput(args)
  const scoreReminder = (session: string) => testSpawnSync(
    ['python3', new URL('../hooks/score-reminder.py', import.meta.url).pathname],
    {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: session })),
      stdout: 'pipe', stderr: 'pipe',
    },
  )
  const orchFrom = (cwd: string, session: string, ...args: string[]) => {
    const p = testSpawnSync([process.execPath, CLI, ...args], {
      cwd,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: session,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const insert = (status: string, job = 'file-question') => (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
  ).get(new Date().toISOString(), job, status) as { id: number }).id
  const checkpointedOrch = async (checkpoint: string, ...args: string[]) => {
    const token = randomUUID()
    const ready = join(dir, `lifecycle-ready-${token}`)
    const release = join(dir, `lifecycle-release-${token}`)
    const child = testSpawn([process.execPath, CLI, ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ORCH_TEST_LIFECYCLE_CHECKPOINT: checkpoint,
        ORCH_TEST_LIFECYCLE_READY: ready,
        ORCH_TEST_LIFECYCLE_RELEASE: release,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const deadline = Date.now() + 5_000
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5)
    expect(existsSync(ready)).toBe(true)
    return { child, release }
  }
  const lifecycleResult = async (child: ReturnType<typeof Bun.spawn>) => {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ])
    return { code, out, err }
  }
  const dispatchArtifacts = (cwd: string) => {
    const root = repoRootOf(cwd) ?? cwd
    const trees = join(root, '.claude', 'worktrees')
    return {
      runs: (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n,
      prompts: existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).sort() : [],
      lock: existsSync(join(root, '.git', 'orch-create.lock')),
      worktrees: existsSync(trees) ? readdirSync(trees).sort() : null,
    }
  }
  const expectNoDispatchArtifacts = (cwd: string, before: ReturnType<typeof dispatchArtifacts>) => {
    expect(dispatchArtifacts(cwd)).toEqual(before)
  }

  const conflictingImplement = (extra: string[]) => {
    const binDir = join(dir, `conflict-warn-bin-${extra.join('-') || 'human'}`)
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    return testSpawnSync(
      [process.execPath, CLI, 'do', 'implement',
        'Make the change.\nThen push the branch.', '--agent', 'codex', ...extra],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1',
      } },
    )
  }

  const expectCreateMigrationRefused = (
    name: string, create: string, token: string, position: number, kind = 'unsupported shell token',
  ) => {
    upsertProject({
      name, path: process.cwd(), settings: { worktree: { create } } as any,
    })
    const r = orch('project', 'migrate-create', name, '--apply')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${kind} ${JSON.stringify(token)} at position ${position}; cannot migrate`)
    expect(projectByName(name)!.settings.worktree?.create as any).toBe(create)
  }
  return { CLI, orchInput, orch, scoreReminder, orchFrom, insert, checkpointedOrch, lifecycleResult, dispatchArtifacts, expectNoDispatchArtifacts, conflictingImplement, expectCreateMigrationRefused }
}

export function worktreeDescribeFixture() {
let priorCleanupSession: string | undefined
  beforeEach(() => {
    priorCleanupSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'worktree-owner-session'
  })
  afterEach(() => {
    if (priorCleanupSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorCleanupSession
  })

  const fromRoot = <T>(fn: () => T): T => {
    const priorDepth = process.env.ORCH_DEPTH
    try {
      process.env.ORCH_DEPTH = '0'
      return fn()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }

  /**
   * The bug shipped because every test called git from the main checkout.
   * `--show-toplevel` is correct THERE and wrong from inside a worktree, which
   * is exactly where one session ran orch and lost a day. The test
   * therefore cds into a real nested worktree.
   */
  const git = (cwd: string, ...args: string[]) => {
    const p = testSpawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  function scratchRepo(): { repo: string; tree: string } {
    const repo = mkdtempSync(join(tmpdir(), 'orch-nested-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'base')
    const tree = join(repo, '.claude', 'worktrees', 'AB-2581')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'AB-2581', tree, 'main')
    return { repo, tree }
  }
  function markScratchRepoOwner(repo: string, tree: string, runId: number): void {
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.orch-run\n')
    writeFileSync(join(tree, '.orch-run'), `${runId}\n${repo}\nsource: git\n`)
  }
  return { priorCleanupSession, fromRoot, git, scratchRepo, markScratchRepoOwner }
}
