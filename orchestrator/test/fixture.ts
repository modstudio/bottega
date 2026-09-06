/** Shared test state and helpers. The preload establishes ORCH_DB before this module imports src. */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchRunEnvelopeSchema } from '../../shared/orch-contract.ts'
import type { WorktreeCreate, WorktreeCreateArg } from '../src/projects.ts'
import { dirname } from 'node:path'
const dir = dirname(process.env.ORCH_DB!)
export { dir }
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
  const made = Bun.spawnSync(['mkfifo', fifo], { stdout: 'pipe', stderr: 'pipe' })
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  try {
    // fd 3 is opened before the sleep, so the producer starts against a pipe
    // whose consumer deliberately does not read until its buffer is full.
    const reader = Bun.spawn(
      ['sh', '-c', 'exec 3<"$1"; sleep 0.25; cat <&3', 'slow-reader', fifo],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const writer = openSync(fifo, 'w')
    const producer = Bun.spawn(argv, { env, stdout: writer, stderr: 'pipe' })
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
mkdirSync(cleanDockerBin)
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
  const p = Bun.spawnSync(['git', ...args], {
    cwd: dir, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
}

export const { db, nowIso, reapStale, pendingForSession, unscoredCount, judgeability, STALE_AFTER_MS,
        PENDING_BOOTSTRAP_MS, WEIGHT, weigh, label, FIDELITY_PENALTY, UNSCORED_WHERE,
        excludeSharedOutputRuns, SHARED_OUTPUT_REASON, applySchema, recordDuels, duelMatrices,
        parseRunIds, recordSessionSeen, GENERIC_QUESTION_TOKENS,
        bootstrapFixtureStore, authorizeRunMutation, adoptRunMutation, sessionId } = await import('../src/db.ts')
export const { candidates, weightCase, scoreboard, median, evidenceFor, pick,
        NOISE_BAND, QUALITY_STEP, MIN_SAMPLE, OUTPUT_RESERVE, EVIDENCE_WINDOW,
        STANDING_EXPLORE_RATE, PROMPT_SIZE_BOUNDARY, promptSizeBucket, betaContribution,
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
export const { JOBS } = await import('../src/jobs.ts')
export const { runDetail, state } = await import('../src/serve.ts')
export const { classify, NEEDS_HUMAN, NEEDS_HUMAN_TITLE, NOT_EVIDENCE, COOLS_DOWN, FAILS_OVER,
        isNonAnswer, detectBlockers } = await import('../src/failure.ts')
export const { errorTail, preflight, preflightMcp, detachedRunOptions, runFilePaths, pruneRuns, KEEP_RUN_FILES_DAYS,
        RUNS_DIR, grokMcpConnection, assertGrokTrustEligible, writingFailoverRefusal, resolveSupersededTurn,
        resolveRootFromLastTurn, gitObjectEnvironmentFor, inferredReadOnlyKey,
        canonSourceFor, canonSourceInstruction, snapshotRegisteredCheckouts,
        changedRegisteredCheckouts, checkoutAliases, checkoutCaseSensitivity,
        retargetRepositoryPrompt, retargetRepositoryPromptForDispatch,
        packedResumePrompt, resolveReviewTarget, implicitReviewWarning, mcpRequestFromStored,
        retryModelForAgent, run: runJob } = await import('../src/run.ts')
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
        READER_DELIVERABLE_FIRST,
        REVIEW_SEVERITY_INSTRUCTION, INFRASTRUCTURE_RECOVERY, COULD_NOT_VERIFY_INSTRUCTION,
        VERIFY_CLAIM_SCHEMA, ISSUE_WORKER_SCHEMA, workerPreamble, workerResumeGuard,
        rulingPrompt, packResumePrompt, contractConflicts, hasRealQuestions, realQuestions } = await import('../src/contract.ts')
export const { cleanReviewEvidence, parseReviewReply, recordReview, recordReviews, gradeReviewLens, reviewPins, coverageAudit,
        triageFinding, completeReview, getReview, listReviews, reviewCalibration,
        reviewCalibrationFleet, calibrationLine,
        MIN_REVIEW_TRIAGED } = await import('../src/review.ts')
export const { ask } = await import('../src/ask.ts')
export const { checkMessages, messageArchitect, messagesForRun } = await import('../src/mailbox.ts')
export const { orphanSafety, repoRootOf, createWorktree, createWithTool, createReadOnlyWorktree,
        createReadOnlyWithTool, resolveBase, fillTool,
        seedArgv, createArgv, worktreeGitDir, prepareWorktreeObjects, prepareSharedRefGuard,
        assertSharedRefGuardOutsideWritableRoots, removeSharedRefGuard,
        workerSharedGitRoots,
        carryWorkingState, withWorktreeCreateLock, withProjectLock, projectLockState,
        reclaimStaleProjectLock, processStartTime, staleProjectLockHolder,
        unmergedBranch, assertCallerAncestry, checkoutHasUncommittedWork, callerDrift,
        changesIn, contentTree, removeFor, branchTip } = await import('../src/worktree.ts')
export const { gateFailureSummary, land, landingStatus, landingReviewCoverage, resolveLandingBranch } = await import('../src/landing.ts')
export const { gitLocks, formatGitLocks } = await import('../src/git-locks.ts')
export const { AGENTS, ARGV_PROMPT_BYTES, localReachable, ensureLocalHealth, resetLocalHealth,
        unavailableReason, available, NEEDS_HEALTH, wakeDecision,
        WAKE_COOLDOWN_MS, CODEX_EXEC_SANDBOX, CODEX_ASK_ENV_VARS, strictCodexSchema,
        qwenSession } = await import('../src/agents.ts')
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
export const { deadRunningProcessConditions, reconcileHub, rulingConditions, monitorHistory, monitor } =
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
}): number {
  return (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                      status, latency_ms, probe, failure_kind, parent_run_id, turn, session_id, stack,
                      model, lens, repo, input_tree, head_commit)
     VALUES (?,?,?,'sha',?,'head',?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    o.startedAt ?? new Date().toISOString(), o.agent, o.job, o.promptBytes ?? 10,
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
    files_covered: ['file.ts'], commands_run: ['bun test'], could_not_verify: [],
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
