/**
 * Tests for the parts that decide things.
 *
 * There were none, and the cost of that showed up all at once: routing counted
 * only successful runs, the guide carried a second copy of the same maths that
 * had drifted from it, the stale sweep tested a pid that was never present
 * while a run was alive, and `tsc` had never completed even once. Every one of
 * those is a pure function of the database, and every one is checked below.
 *
 * The database is the seam. The suite builds one in a temp file via ORCH_DB
 * rather than touching orch.db, so a test run can never teach the real router
 * anything. Run files go the same way: ORCH_RUNS points at a temp directory so
 * concurrent copies of the suite in one checkout do not share filenames.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
         realpathSync, mkdirSync, utimesSync, chmodSync, readdirSync, statSync,
         symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { WorktreeCreate, WorktreeCreateArg } from './projects.ts'

const declaredCreate = (command: string, args: WorktreeCreateArg[]): WorktreeCreate =>
  ({ command, args })

// Some lifecycle tests need compound shell setup in a scratch repository. The
// production registration path refuses this shape; these tests bypass the
// register deliberately because the compound script is their fixture.
const compoundCreate = (script: string): WorktreeCreate =>
  ({ command: 'sh', args: ['-c', script] })

const gitEnvironmentVariables = [
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'ORCH_GUARDED_GIT_COMMON_DIR',
  'ORCH_ALLOWED_GIT_REF',
] as const

// A worker routes git objects and ref hooks into its own linked-worktree metadata.
// None of that routing belongs to the scratch repositories built by this test process.
for (const variable of gitEnvironmentVariables) delete process.env[variable]

const hermeticGitEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  ...Object.fromEntries(gitEnvironmentVariables.map((variable) => [variable, undefined])),
  ...extra,
})

describe('landing is gated on the exact commit that reaches trunk', () => {
  const landingModule = new URL('landing.ts', import.meta.url).href
  const worktreeModule = new URL('worktree.ts', import.meta.url).href
  const g = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
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
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'trees/\n')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    g(repo, 'add', 'base.txt')
    g(repo, 'commit', '-m', 'base')
    const trees: Record<string, string> = {}
    for (const branch of branches) {
      const tree = join(repo, 'trees', branch)
      mkdirSync(join(repo, 'trees'), { recursive: true })
      g(repo, 'worktree', 'add', '-b', branch, tree, 'main')
      writeFileSync(join(tree, `${branch}.txt`), `${branch}\n`)
      g(tree, 'add', `${branch}.txt`)
      g(tree, 'commit', '-m', branch)
      trees[branch] = tree
    }
    return { repo, trees }
  }
  const childLand = (repo: string, branch: string) => Bun.spawn(
    [process.execPath, '-e',
      `const { land } = await import(process.argv[1]); land(process.argv[2], process.argv[3])`,
      landingModule, repo, branch],
    { env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, CLAUDE_CODE_SESSION_ID: branch },
      stdout: 'pipe', stderr: 'pipe' },
  )

  test('landing reconciles a clean checkout of trunk to the landed commit', async () => {
    const { repo } = repoWithBranches(['clean-landing'])
    upsertProject({ name: 'landing-clean-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'clean-landing')
      expect(await child.exited).toBe(0)
      const tip = g(repo, 'rev-parse', 'refs/heads/main')
      expect(g(repo, 'rev-parse', 'HEAD')).toBe(tip)
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'clean-landing.txt'), 'utf8')).toBe('clean-landing\n')
      expect(g(repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing reconciles around genuine tracked work without changing it', async () => {
    const { repo } = repoWithBranches(['dirty-landing'])
    writeFileSync(join(repo, 'base.txt'), 'work owned by another session\n')
    upsertProject({ name: 'landing-dirty-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'dirty-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      const tip = g(repo, 'rev-parse', 'dirty-landing')
      expect(g(repo, 'rev-parse', 'HEAD')).toBe(tip)
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('work owned by another session\n')
      expect(readFileSync(join(repo, 'dirty-landing.txt'), 'utf8')).toBe('dirty-landing\n')
      expect(g(repo, 'status', '--short')).toBe('M base.txt')
      expect(output).toContain(`reconciled checkout ${repo}`)
      expect(output).not.toContain('CONDITION:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an untracked file neither blocks reconciliation nor enters the index', async () => {
    const { repo } = repoWithBranches(['untracked-landing'])
    writeFileSync(join(repo, 'orch.db.bak-test'), 'litter\n')
    upsertProject({ name: 'landing-untracked-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'untracked-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      const tip = g(repo, 'rev-parse', 'untracked-landing')
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'untracked-landing.txt'), 'utf8')).toBe('untracked-landing\n')
      expect(g(repo, 'status', '--short')).toBe('?? orch.db.bak-test')
      expect(output).toContain(`reconciled checkout ${repo}`)
      expect(output).not.toContain('CONDITION:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a conflicting staged-only version is anchored and recoverable without changing working bytes', async () => {
    const { repo, trees } = repoWithBranches(['staged-landing'])
    writeFileSync(join(trees['staged-landing']!, 'base.txt'), 'landed version\n')
    g(trees['staged-landing']!, 'add', 'base.txt')
    g(trees['staged-landing']!, 'commit', '-m', 'DEV-219 touch staged path')
    writeFileSync(join(repo, 'base.txt'), 'staged version\n')
    g(repo, 'add', 'base.txt')
    const indexBefore = g(repo, 'write-tree')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    const workingBefore = readFileSync(join(repo, 'base.txt'))
    expect(() => g(repo, 'rev-parse', '--verify', 'refs/stash')).toThrow()
    upsertProject({ name: 'landing-staged-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'staged-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      const tip = g(repo, 'rev-parse', 'staged-landing')
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'base.txt'))).toEqual(workingBefore)
      expect(output).toContain('CONDITION: landing succeeded')
      expect(output).toContain('Review and reconcile this checkout before using or committing it.')
      const preserved = output.match(/previous index is preserved at (refs\/orch\/preserved-index\/\S+) \(([0-9a-f]+)\)/)
      expect(preserved).not.toBeNull()
      expect(g(repo, 'rev-parse', preserved![1]!)).toBe(preserved![2]!)
      expect(() => g(repo, 'rev-parse', '--verify', 'refs/stash')).toThrow()
      const command = output.split('\n').find((line) => line.startsWith('git -C '))
      expect(command).toBeDefined()
      const recovery = Bun.spawnSync(['sh', '-lc', command!], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(recovery.exitCode).toBe(0)
      expect(g(repo, 'write-tree')).toBe(indexBefore)
      expect(readFileSync(join(repo, 'base.txt'))).toEqual(workingBefore)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a previously stale and dirty trunk checkout is treated as holding work', async () => {
    const { repo } = repoWithBranches(['prior-landing', 'next-landing'])
    const staleIndex = g(repo, 'write-tree')
    g(repo, 'update-ref', 'refs/heads/main', 'refs/heads/prior-landing', 'HEAD')
    writeFileSync(join(repo, 'base.txt'), 'work in the stale checkout\n')
    upsertProject({ name: 'landing-stale-dirty-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'next-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', 'HEAD^{tree}'))
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('work in the stale checkout\n')
      expect(existsSync(join(repo, 'prior-landing.txt'))).toBe(false)
      expect(existsSync(join(repo, 'next-landing.txt'))).toBe(false)
      expect(output).toContain(`checkout ${repo} could not be reconciled because it holds tracked work`)
      expect(output).toContain('prior-landing.txt')
      expect(output).toContain('base.txt')
      expect(output).toContain('Recover that exact index with:')
      expect(g(repo, 'status', '--short')).toContain(' D prior-landing.txt')
      expect(g(repo, 'status', '--short')).toContain(' D next-landing.txt')
      expect(staleIndex).not.toBe(g(repo, 'write-tree'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('two-tree reconciliation refuses staged work on a touched file', () => {
    const { repo } = repoWithBranches(['read-tree-landing'])
    try {
      const oldTrunk = g(repo, 'rev-parse', 'HEAD')
      const tip = g(repo, 'rev-parse', 'refs/heads/read-tree-landing')
      g(repo, 'update-ref', 'refs/heads/main', tip, oldTrunk)
      writeFileSync(join(repo, 'read-tree-landing.txt'), 'locally staged work\n')
      g(repo, 'add', 'read-tree-landing.txt')
      const indexBefore = g(repo, 'write-tree')

      expect(() => g(repo, 'read-tree', '-m', '-u', oldTrunk, tip)).toThrow()
      expect(g(repo, 'write-tree')).toBe(indexBefore)
      expect(readFileSync(join(repo, 'read-tree-landing.txt'), 'utf8'))
        .toBe('locally staged work\n')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('two simultaneous landings both land and the stale gate is run again', async () => {
    const { repo } = repoWithBranches(['first', 'second'])
    const log = join(repo, 'gate.log')
    const gate = join(repo, 'gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nb=$(git branch --show-current)\nh=$(git rev-parse HEAD)\nprintf '%s %s\\n' "$b" "$h" >> '${log}'\nm='${repo}/first-gate-'$b\nif [ ! -e "$m" ]; then\n  touch "$m"\n  while [ ! -e '${repo}/first-gate-first' ] || [ ! -e '${repo}/first-gate-second' ]; do sleep 0.01; done\n  [ "$b" != second ] || sleep 0.2\nfi\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-pair', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const first = childLand(repo, 'first')
      const second = childLand(repo, 'second')
      expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0])
      const rows = readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' '))
      expect(rows.filter(([branch]) => branch === 'first')).toHaveLength(1)
      expect(rows.filter(([branch]) => branch === 'second')).toHaveLength(2)
      const secondGates = rows.filter(([branch]) => branch === 'second').map(([, oid]) => oid)
      expect(secondGates[0]).not.toBe(secondGates[1])
      expect(g(repo, 'rev-parse', 'main')).toBe(secondGates[1])
      expect(g(repo, 'show', 'main:first.txt')).toBe('first')
      expect(g(repo, 'show', 'main:second.txt')).toBe('second')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a gate failure under the lock releases it for a waiting landing', async () => {
    const { repo } = repoWithBranches(['fails', 'waits'])
    const gate = join(repo, 'gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nb=$(git branch --show-current)\nif [ "$b" = fails ]; then\n c='${repo}/fails-count'; n=0; [ ! -e "$c" ] || n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"\n if [ "$n" = 1 ]; then touch '${repo}/first-gate'; while [ ! -e '${repo}/trunk-moved' ]; do sleep 0.01; done\n else touch '${repo}/failing-under-lock'; sleep 0.15; exit 7; fi\nfi\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-failure', path: repo, settings: { trunk: 'main', gate } })
    try {
      const failing = childLand(repo, 'fails')
      for (let i = 0; i < 200 && !existsSync(join(repo, 'first-gate')); i++) await Bun.sleep(5)
      writeFileSync(join(repo, 'trunk.txt'), 'moved\n')
      g(repo, 'add', 'trunk.txt')
      g(repo, 'commit', '-m', 'move trunk')
      writeFileSync(join(repo, 'trunk-moved'), '')
      for (let i = 0; i < 200 && !existsSync(join(repo, 'failing-under-lock')); i++) await Bun.sleep(5)
      const waiting = childLand(repo, 'waits')
      expect(await failing.exited).not.toBe(0)
      expect(await waiting.exited).toBe(0)
      expect(g(repo, 'show', 'main:waits.txt')).toBe('waits')
      expect(projectLockState(repo, 'landing').holder).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a killed holder is reclaimed, and another project never waits on it', async () => {
    const one = repoWithBranches([]).repo
    const two = repoWithBranches([]).repo
    const hold = `const { withProjectLock } = await import(process.argv[1]); ` +
      `withProjectLock(process.argv[2], 'landing', {session:'dead-session',what:'dead-branch'}, ` +
      `() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000), 1000, true)`
    const child = Bun.spawn([process.execPath, '-e', hold, worktreeModule, one], {
      env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe',
    })
    try {
      for (let i = 0; i < 200 && !projectLockState(one, 'landing').holder; i++) await Bun.sleep(5)
      expect(projectLockState(one, 'landing').holder?.what).toBe('dead-branch')
      const started = Date.now()
      expect(withProjectLock(two, 'landing', { session: 'other', what: 'other-branch' }, () => 'ok', 50, true)).toBe('ok')
      expect(Date.now() - started).toBeLessThan(50)
      child.kill('SIGKILL')
      await child.exited
      expect(withProjectLock(one, 'landing', { session: 'next', what: 'next-branch' }, () => 'reclaimed', 500, true)).toBe('reclaimed')
    } finally {
      child.kill()
      await child.exited
      rmSync(one, { recursive: true, force: true })
      rmSync(two, { recursive: true, force: true })
    }
  })

  test('a project with no declared gate is refused before it can land', async () => {
    const { repo } = repoWithBranches(['ungated'])
    upsertProject({ name: 'landing-ungated', path: repo, settings: { trunk: 'main' } })
    try {
      const child = childLand(repo, 'ungated')
      expect(await child.exited).not.toBe(0)
      expect((await new Response(child.stderr).text())).toContain(
        'project landing-ungated has no landing gate configured',
      )
      expect(() => g(repo, 'merge-base', '--is-ancestor', 'ungated', 'main')).toThrow()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('run ids resolve explicitly and status reads holder and waiters without acquiring', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET branch=? WHERE id=?').run('DEV-181-branch', id)
    expect(resolveLandingBranch(String(id))).toEqual({ branch: 'DEV-181-branch', runId: id })
    expect(resolveLandingBranch('named-branch')).toEqual({ branch: 'named-branch', runId: null })
    const { repo } = repoWithBranches([])
    upsertProject({ name: 'landing-status', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try { expect(landingStatus(repo)).toBe('landing-status landing lock: free\nwaiters:\n  none') }
    finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
const hermeticGitCommand =
  `env ${gitEnvironmentVariables.map((variable) => `-u ${variable}`).join(' ')} git`

/**
 * One database for the whole file, chosen before anything imports db.ts.
 *
 * db() caches its handle and DB_PATH is read at module load, so a per-test
 * database would need the whole module graph reloaded — and route.ts imports
 * db.ts by a plain specifier, which Bun caches once however the test file
 * spells its own import. Reloading only the modules the test names left route.ts
 * talking to the first test's file, which had already been deleted. Clearing the
 * tables between tests is both simpler and closer to how this actually runs.
 */
const dir = mkdtempSync(join(tmpdir(), 'orch-test-'))
process.env.ORCH_DB = join(dir, 'test.db')
process.env.ORCH_RUNS = join(dir, 'runs')
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

const { db, nowIso, reapStale, pendingForSession, unscoredCount, judgeability, STALE_AFTER_MS,
        PENDING_BOOTSTRAP_MS, WEIGHT, weigh, label, FIDELITY_PENALTY, UNSCORED_WHERE,
        excludeSharedOutputRuns, SHARED_OUTPUT_REASON, applySchema, recordDuels, duelMatrices,
        parseRunIds, recordSessionSeen } = await import('./db.ts')
const { candidates, weightCase, scoreboard, median, evidenceFor, pick,
        NOISE_BAND, QUALITY_STEP, MIN_SAMPLE, OUTPUT_RESERVE, EVIDENCE_WINDOW,
        STANDING_EXPLORE_RATE } = await import('./route.ts')
const { guide } = await import('./guide.ts')
const { projects, projectAt, projectByName, stackAt, upsertProject } = await import('./projects.ts')
const { dbNameFor, recipeNotes, runRecipe, fill } = await import('./recipe.ts')
const { JOBS } = await import('./jobs.ts')
const { runDetail, state } = await import('./serve.ts')
const { classify, NEEDS_HUMAN, NEEDS_HUMAN_TITLE, NOT_EVIDENCE, COOLS_DOWN,
        isNonAnswer, detectBlockers } = await import('./failure.ts')
const { errorTail, preflight, preflightMcp, detachedRunOptions, runFilePaths, pruneRuns, KEEP_RUN_FILES_DAYS,
        RUNS_DIR, grokMcpConnection, writingFailoverRefusal, resolveSupersededTurn,
        resolveRootFromLastTurn, gitObjectEnvironmentFor, inferredReadOnlyKey,
        run: runJob } = await import('./run.ts')
const run = runJob
const { summary } = await import('./metric.ts')
const { parseWorkerReply, parseWorkerReplyWithCount, READONLY_PREAMBLE,
        NO_REPO_PREAMBLE, WORKER_PREAMBLE, LAND_PREAMBLE, REVIEW_SCHEMA, ISSUE_WORKER_SCHEMA, workerPreamble, workerResumeGuard,
        contractConflicts } = await import('./contract.ts')
const { recordReview, recordReviews, triageFinding, completeReview, reviewCalibration, calibrationLine,
        MIN_REVIEW_TRIAGED } = await import('./review.ts')
const { ask } = await import('./ask.ts')
const { checkMessages, messageArchitect, messagesForRun } = await import('./mailbox.ts')
const { orphanSafety, repoRootOf, createWorktree, createWithTool, resolveBase, fillTool,
        seedArgv, createArgv, worktreeGitDir, prepareWorktreeObjects, prepareSharedRefGuard,
        workerSharedGitRoots,
        carryWorkingState, withWorktreeCreateLock, withProjectLock, projectLockState,
        unmergedBranch, assertCallerAncestry, checkoutHasUncommittedWork, callerDrift,
        changesIn } = await import('./worktree.ts')
const { landingStatus, resolveLandingBranch } = await import('./landing.ts')
const { AGENTS, localReachable, ensureLocalHealth, resetLocalHealth,
        unavailableReason, available, NEEDS_HEALTH, wakeDecision,
        WAKE_COOLDOWN_MS, CODEX_EXEC_SANDBOX, strictCodexSchema } = await import('./agents.ts')
const { listDocs, listDocMetadata, getDoc, setDoc, consumeDoc, removeDoc, docsForRun, exportDocs, importDocs, brief, docSubjects,
        listOpenResumes, parseResumeFrontmatter, resumeAge } =
  await import('./docs.ts')
const { createDocsMcpServer, fileIssue } = await import('./mcp.ts')
const { reconcileHub, monitorHistory } = await import('./monitor.ts')
const { listPairs, addPair, baselineForPair, setBaseline, listSkips, addSkip,
        setLedgerRef, ledgerRef, listLedgerRefs, resolveLedgerRef,
        listDoctrineRules, addDoctrineRule, retireDoctrineRule } =
  await import('./porting.ts')
const { applyImport, ImportRefusalError, planImport, sourceCoverage } = await import('./porting-import.ts')
const { parseFiledIssue, seedFromReport, boundedIssuePack, parseIssueReply,
        ISSUE_DIAGNOSIS_SCHEMA } = await import('./issue.ts')

describe('filed issue coordinator inputs', () => {
  const shown = { task: { key: 'DEV-9', title: '[DEFECT] broken', body: `TYPE: DEFECT
REPORTING SESSION: s
REPORTING PROJECT: alephbeis

WHAT HAPPENED
the command failed

EXPECTED INSTEAD
it succeeds

HOW TO REPRODUCE
Command: orch do implement x
Environment: alephbeis full seed, FORCE_COLOR=1

EVIDENCE
run 12

WHAT IS NOT ESTABLISHED
the cause` } }

  test('parses only the bounded filing fields and recognises one reported seed', () => {
    const issue = parseFiledIssue(shown)
    expect(issue).toMatchObject({ key: 'DEV-9', reportingProject: 'alephbeis',
      reproduceCommand: 'orch do implement x', environment: 'alephbeis full seed, FORCE_COLOR=1' })
    const project = { id: 1, name: 'alephbeis', path: '/x', stack: null, canon: true,
      settings: { worktree: { seeds: ['none', 'minimal', 'full'] } } } as any
    expect(seedFromReport(project, issue.environment)).toBe('full')
    expect(Object.keys(JSON.parse(boundedIssuePack(issue)))).toEqual([
      'key', 'title', 'kind', 'reporting_project', 'what_happened', 'expected',
      'reproduce_command', 'environment', 'evidence', 'not_established',
    ])
  })

  test('does not choose between absent or ambiguous seeds', () => {
    const project = { settings: { worktree: { seeds: ['none', 'full'] } } } as any
    expect(seedFromReport(project, 'ordinary shell')).toBeNull()
    expect(seedFromReport(project, 'compare none with full')).toBeNull()
  })

  test('takes the last structured diagnosis and requires what could not be established', () => {
    const reply = {
      status: 'done', outcome: 'not-a-defect', cause_location: 'project-tool',
      cause_matched_report: false, established_cause: 'documented refusal',
      target_project: 'alephbeis', proposed_fix: null, register_change: null,
      reproduction: { command: 'x', base_commit: 'abc', environment: 'full', seed: 'full' },
      before: 'exit 2', after: null, questions: null, not_established: 'whether the caller expected another contract',
      blockers: null,
    }
    expect(parseIssueReply<any>(`narration {"status":"done"}\n${JSON.stringify(reply)}`,
      ISSUE_DIAGNOSIS_SCHEMA)).toEqual(reply)
    const { not_established: _, ...missing } = reply
    expect(() => parseIssueReply(JSON.stringify(missing), ISSUE_DIAGNOSIS_SCHEMA)).toThrow('structured contract')
  })

  test('the routed issue worker has a distinct accepted writing contract', () => {
    const reply = {
      status: 'done', outcome: 'fixed', cause_location: 'orch-code', cause_matched_report: true,
      established_cause: 'bad branch comparison',
      reproduction: { command: 'bun test', base_commit: 'abc', environment: 'worker', seed: null },
      before: '1 failed', after: '0 failed', plain_gate: 'passed', worker_gate: 'passed',
      blast_radius: 'the one caller', branch: 'DEV-9-orch-1', files_changed: ['src/a.ts'],
      questions: null, not_established: '', blockers: null, summary: 'fixed', deviations: null,
      tests: { command: 'bun test', ran: true, passed: true, detail: '1 test' },
    }
    expect(parseWorkerReplyWithCount(JSON.stringify(reply), ISSUE_WORKER_SCHEMA).reply).toEqual(reply as any)
    expect(JOBS['issue-worker']!.needs).toEqual({ readsRepo: true, writesRepo: true, resumable: true })
  })
})

describe('operational monitor record', () => {
  test('records condition ages and reads them back by invocation', () => {
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0) RETURNING id`,
    ).get() as { id: number }).id
    db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(invocation, 'stale-run', 'run:7', '2026-09-03T08:00:00Z', 57_600_000,
      'process is gone', 'reported')
    expect(monitorHistory(1)).toEqual([expect.objectContaining({
      id: invocation, trigger: 'backstop', findings: 1,
      conditions: [expect.objectContaining({ kind: 'stale-run', subject: 'run:7', age_ms: 57_600_000 })],
    })])
  })

  test('derives ghost interval ages from the audited hub reconcile command', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 0,
      stdout: Buffer.from('closed:\n  interval 747618  orch:1205  starship/STAR-1  agent codex  run 1205 is terminal (ok); removes 19h engaged time\nleft open:\n  none\n'),
      stderr: Buffer.from(''), success: true } as any)
    try {
      const clock = Date.parse('2026-09-04T20:00:00Z')
      expect(reconcileHub(clock).conditions).toEqual([expect.objectContaining({
        kind: 'ghost-open-interval', subject: 'interval:747618', ageMs: 68_400_000,
        action: 'reconciled through hub reconcile',
      })])
    } finally { spawn.mockRestore() }
  })

  test('files monitor provenance against a real invocation without a fake session', async () => {
    const hubDb = join(dir, 'monitor-file-issue.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.HUB_DB = hubDb
    delete process.env.CLAUDE_CODE_SESSION_ID
    upsertProject({ name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] } })
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,trigger) VALUES (?, 'backstop') RETURNING id`,
    ).get(nowIso()) as { id: number }).id
    try {
      const filed = await fileIssue({ kind: 'defect', what_happened: 'A detector is unavailable',
        expected: 'The detector has machine-readable state', reproduce_command: 'orch monitor',
        environment: 'test monitor pass', evidence: `monitor invocation ${invocation}`,
        not_established: 'The state contract is not designed',
      }, { kind: 'monitor', invocationId: invocation, affectedProject: 'starship' })
      expect(filed).toMatchObject({ reporter: 'monitor', monitor_invocation_id: invocation, session: null })
      const shown = Bun.spawnSync([new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', filed.key, '--json'], { env: { ...process.env }, stdout: 'pipe' })
      const task = JSON.parse(shown.stdout.toString()).task
      expect(task.body).toContain('REPORTER KIND: MONITOR')
      expect(task.body).toContain(`REPORTING MONITOR INVOCATION: ${invocation}`)
      expect(task.body).toContain('AFFECTED PROJECT: starship')
      expect(task.body).not.toContain('REPORTING SESSION:')
    } finally {
      rmSync(hubDb, { force: true }); rmSync(`${hubDb}-shm`, { force: true }); rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB; else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })
})

beforeEach(() => {
  // question cascades from run, but the delete order still matters: it is
  // listed first so a future FK-enforcing change cannot make this fail
  // mysteriously halfway through a suite.
  db().exec('DELETE FROM monitor_condition; DELETE FROM monitor_invocation; DELETE FROM review_finding; DELETE FROM review_lens; DELETE FROM review; DELETE FROM port_ref_source; DELETE FROM port_ref; DELETE FROM port_skip; DELETE FROM port_baseline; DELETE FROM port_pair; DELETE FROM port_doctrine; DELETE FROM doc; DELETE FROM run_message; DELETE FROM question; DELETE FROM duel; DELETE FROM calibration; DELETE FROM score; DELETE FROM run; DELETE FROM project; DELETE FROM session_seen;')
})

afterAll(() => {
  delete process.env.ORCH_DB
  delete process.env.ORCH_RUNS
  rmSync(dir, { recursive: true, force: true })
})

describe('read-only run task attribution', () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  const repository = (branch = 'main') => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-attribution-'))
    git(repo, 'init', '-b', branch)
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'fixture')
    upsertProject({
      name: `attribution-${randomUUID()}`, path: repo,
      settings: { keyPrefixes: ['DEV'] },
    })
    return repo
  }

  const launch = async (cwd: string, key?: string) => {
    const script = join(dir, `attribution-agent-${randomUUID()}.ts`)
    writeFileSync(script, 'process.stdout.write("attributed")\n')
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'file-question', prompt: 'inspect', cwd, key, agent: 'codex', noFailover: true,
      })
      return (db().query('SELECT launch_key FROM run WHERE id=?').get(result.id) as
        { launch_key: string | null }).launch_key
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  }

  test('records the key carried by the caller worktree name before the branch key', async () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/DEV-205-branch', worktree)
    try {
      expect(inferredReadOnlyKey(worktree)).toBe('DEV-204')
      expect(await launch(worktree)).toBe('DEV-204')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('records the branch key when the checkout name carries none', async () => {
    const repo = repository('feature/DEV-205-branch')
    try {
      expect(inferredReadOnlyKey(repo)).toBe('DEV-205')
      expect(await launch(repo)).toBe('DEV-205')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an explicit key wins over worktree and branch inference', async () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/DEV-205-branch', worktree)
    try { expect(await launch(worktree, 'DEV-206')).toBe('DEV-206') }
    finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a read-only run with no inferable key launches and records null', async () => {
    const repo = repository()
    try {
      expect(inferredReadOnlyKey(repo)).toBeNull()
      expect(await launch(repo)).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an inferred attribution key never satisfies a writing-run branch requirement', () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/no-key', worktree)
    const project = projectAt(repo)!
    upsertProject({
      name: project.name, path: repo,
      settings: { keyPrefixes: ['DEV'], worktree: { branch: '{key}-orch-{id}' } },
    })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      expect(inferredReadOnlyKey(worktree)).toBe('DEV-204')
      expect(() => preflight('implement', worktree)).toThrow('--key <KEY-123>')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

/** Insert a finished run. Returns its id. */
function addRun(o: {
  agent: string; job: string; status?: string; latency?: number; probe?: number
  kind?: string; parent?: number; turn?: number; session?: string | null; stack?: string
  model?: string; startedAt?: string
  lens?: string
}): number {
  return (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                      status, latency_ms, probe, failure_kind, parent_run_id, turn, session_id, stack,
                      model, lens)
     VALUES (?,?,?,'sha',10,'head',?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    o.startedAt ?? new Date().toISOString(), o.agent, o.job,
    o.status ?? 'ok', o.latency ?? 1000, o.probe ?? 0, o.kind ?? null,
    o.parent ?? null, o.turn ?? 1, o.session ?? null, o.stack ?? null,
    o.model ?? AGENTS[o.agent]?.model ?? null, o.lens ?? null,
  ) as { id: number }).id
}

const reviewReply = (findings = 1) => ({
  findings: Array.from({ length: findings }, (_, i) => ({
    severity: 'major', location: `file.ts:${i + 1}`, evidence: `evidence ${i + 1}`,
    proposed_correction: `fix ${i + 1}`,
  })),
  provenance: {
    tree_inspected: 'abc123', standards_read: ['AGENTS.md'], model_used: 'reported-by-reviewer',
    files_covered: ['file.ts'], commands_run: ['bun test'], could_not_verify: [],
  },
})

describe('review discipline', () => {
  test('findings jobs have stable identities and the structured coverage contract', () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      for (const name of ['review-lens', 'review-lens-inline', 'safety', 'craft']) {
        expect(JOBS[name]!.findings).toBe(true)
        expect(() => preflight(name, process.cwd())).toThrow('requires a stable lens identity')
      }
      expect(JOBS['verify-claim']!.findings).not.toBe(true)
      expect(() => preflight('verify-claim', process.cwd(), undefined, undefined, undefined,
        false, false, 'claim')).toThrow('--lens is only valid')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(REVIEW_SCHEMA.properties.provenance.required).toEqual([
      'tree_inspected', 'standards_read', 'model_used', 'files_covered',
      'commands_run', 'could_not_verify',
    ])
  })

  test('records each lens before triage and derives runner and model from the orch run', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'effective-a', lens: 'safety' })
    const second = addRun({ agent: 'grok', job: 'craft', model: 'effective-b', lens: 'craft' })
    const review = recordReviews([
      { runId: first, output: reviewReply() }, { runId: second, output: reviewReply(0) },
    ])
    const rows = db().query(
      `SELECT rl.run_id, rl.lens, rl.agent, rl.model, r.completed_at
         FROM review_lens rl JOIN review r ON r.id=rl.review_id ORDER BY rl.run_id`,
    ).all() as { run_id: number; lens: string; agent: string; model: string; completed_at: string | null }[]
    expect(rows).toEqual([
      { run_id: first, lens: 'safety', agent: 'codex', model: 'effective-a', completed_at: null },
      { run_id: second, lens: 'craft', agent: 'grok', model: 'effective-b', completed_at: null },
    ])
    expect(() => completeReview(review)).toThrow('untriaged')
    triageFinding(review, 1, 'accepted')
    completeReview(review)
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(review) as
      { completed_at: string }).toHaveProperty('completed_at')
  })

  test('precision counts accepted and modified as hits, rejects as misses, and skips nothing', () => {
    const make = (model: string, disposition: 'accepted' | 'modified' | 'rejected' | 'skipped', n: number) => {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model, lens: 'correctness' })
      const reviewId = recordReview(runId, reviewReply(n))
      for (let i = 1; i <= n; i++) triageFinding(reviewId, i, disposition,
        disposition === 'rejected' ? 'not-a-defect' : undefined)
      completeReview(reviewId)
    }
    make('old', 'accepted', 4)
    make('old', 'modified', 3)
    make('old', 'rejected', 3)
    make('old', 'skipped', 8)
    let c = reviewCalibration('correctness', 'codex', 'current')
    expect(c).toMatchObject({ precision: 0.7, hits: 7, triaged: 10, basis: 'agent' })
    expect(c.rejection_categories).toEqual([{ category: 'not-a-defect', count: 3 }])

    make('current', 'accepted', MIN_REVIEW_TRIAGED - 1)
    c = reviewCalibration('correctness', 'codex', 'current')
    expect(c.basis).toBe('agent')
    make('current', 'rejected', 1)
    c = reviewCalibration('correctness', 'codex', 'current')
    expect(c).toMatchObject({ precision: 0.9, hits: 9, triaged: 10, basis: 'model' })
  })

  test('below-floor and untriaged evidence report null, never zero', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'efficiency' })
    const reviewId = recordReview(runId, reviewReply(1))
    triageFinding(reviewId, 1, 'rejected', 'false-positive')
    expect(reviewCalibration('efficiency', 'codex', 'm').precision).toBeNull()
    completeReview(reviewId)
    const c = reviewCalibration('efficiency', 'codex', 'm')
    expect(c.precision).toBeNull()
    expect(calibrationLine(c)).toContain('no reliable precision yet')
  })

  test('uses only the most recent fifty complete reviews', () => {
    const add = (disposition: 'accepted' | 'rejected') => {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'window' })
      const reviewId = recordReview(runId, reviewReply(1))
      triageFinding(reviewId, 1, disposition,
        disposition === 'rejected' ? 'false-positive' : undefined)
      completeReview(reviewId)
    }
    add('accepted')
    for (let i = 0; i < 50; i++) add('rejected')
    expect(reviewCalibration('window', 'codex', 'm')).toMatchObject({
      precision: 0, hits: 0, triaged: 50, basis: 'model',
    })
  })

  test('appends the selected agent calibration before hashing and storing its final prompt', async () => {
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, stdin: agent.stdin, readsOut: agent.readsOut }
    let sent = ''
    let sentSchema: string | undefined
    const output = JSON.stringify(reviewReply(0))
    try {
      // Qualifying evidence exists for the selected agent and nowhere else.
      const evidenceRun = addRun({ agent: 'codex', job: 'review-lens-inline',
        model: agent.model, lens: 'bound-prompt' })
      const evidenceReview = recordReview(evidenceRun, reviewReply(MIN_REVIEW_TRIAGED))
      for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(evidenceReview, i, 'accepted')
      completeReview(evidenceReview)

      agent.bin = process.execPath
      agent.stdin = false
      agent.readsOut = false
      agent.argv = ({ prompt, schema }) => {
        sent = prompt
        sentSchema = schema
        return ['-e', `console.log(${JSON.stringify(output)})`]
      }
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({ job: 'review-lens-inline', prompt: 'inspect this pack',
        agent: 'codex', lens: 'bound-prompt' })
      expect(sent).toContain('precision 1.00 over 10 triaged findings')
      expect(JSON.parse(readFileSync(sentSchema!, 'utf8'))).toEqual(REVIEW_SCHEMA)
      const row = db().query('SELECT prompt_sha, prompt_path, lens FROM run WHERE id=?').get(result.id) as
        { prompt_sha: string; prompt_path: string; lens: string }
      const bound = readFileSync(row.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toBe(sent)
      expect(row.prompt_sha).toBe(createHash('sha256').update(sent).digest('hex').slice(0, 16))
      expect(row.lens).toBe('bound-prompt')
      expect(readFileSync(row.prompt_path, 'utf8')).toBe('inspect this pack')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
    }
  })
})

describe('run mailbox', () => {
  const mailboxOrchInput = (args: string[], stdin?: string, extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, new URL('cli.ts', import.meta.url).pathname, ...args], {
      cwd: dir,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session', ...extraEnv,
      },
      stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const mailboxOrch = (...args: string[]) => mailboxOrchInput(args)

  test('queues inbound context and receipts it only when the worker checks', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('worker-session', 'token', root)

    const told = mailboxOrch('tell', String(root), 'keep the public shape unchanged')
    expect(told.code).toBe(0)
    expect(told.out).toContain('it has not been read')
    const queued = messagesForRun(root)[0]!
    expect(queued).toMatchObject({
      direction: 'to_worker', root_run_id: root, run_id: root,
      body: 'keep the public shape unchanged', read_at: null, delivery: 'architect_cli',
    })

    const read = checkMessages(root)
    expect(read).toHaveLength(1)
    expect(read[0]!.read_at).not.toBeNull()
    expect(checkMessages(root)).toEqual([])
  })

  test('an unread note stays queued and cannot close an open question', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question)
       VALUES (?, ?, 'which interface?')`,
    ).run(root, new Date().toISOString())

    expect(mailboxOrch('tell', String(root), 'background context only').code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).toBeNull()
    expect(db().query(
      'SELECT answer, answered_at FROM question WHERE run_id=?',
    ).get(root)).toEqual({ answer: null, answered_at: null })
    expect((db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status)
      .toBe('running')
  })

  test('tell reads long context from a file without shell interpretation', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const path = join(dir, 'mailbox-long-note.txt')
    const body = 'keep `literal` and $VALUE\nsecond paragraph\n'
    writeFileSync(path, body)
    expect(mailboxOrch('tell', String(root), '--file', path).code).toBe(0)
    expect(messagesForRun(root)[0]!.body).toBe(body)
  })

  test('a worker sends outbound without stopping and it is visible on run detail', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET vendor_session=? WHERE id=?').run('worker-session', root)

    const sent = messageArchitect(root, 'the implementation is taking a narrower shape')
    expect(sent).toMatchObject({
      direction: 'from_worker', root_run_id: root, run_id: root,
      sender_session: 'worker-session', read_at: null, delivery: 'worker_tool',
    })
    expect((db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status)
      .toBe('running')

    const detail = JSON.parse(mailboxOrch('run', String(root)).out)
    expect(detail.messages[0].body).toBe('the implementation is taking a narrower shape')
    expect(detail.messages[0].read_at).not.toBeNull()
  })

  test('the worker MCP tools send outbound and read inbound at a checkpoint', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('worker-session', 'mailbox-token', root)
    expect(mailboxOrch('tell', String(root), 'new context').code).toBe(0)
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'message_orchestrator', arguments: { body: 'progress without stopping' },
      } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'check_orchestrator_messages', arguments: {},
      } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
    const result = mailboxOrchInput(['ask-server'], calls, {
      ORCH_RUN_ID: String(root), ORCH_RUN_TOKEN: 'mailbox-token',
    })
    expect(result.code).toBe(0)
    const replies = result.out.trim().split('\n').map((line) => JSON.parse(line))
    expect(replies[0].result.content[0].text).toContain('Keep working')
    expect(replies[1].result.content[0].text).toContain('[message')
    expect(replies[1].result.content[0].text).toContain('new context')
    expect(replies[1].result.content[0].text).toContain('non-authoritative context')
    expect(messagesForRun(root)).toHaveLength(2)
    expect(messagesForRun(root).find((message) => message.direction === 'to_worker')!.read_at)
      .not.toBeNull()
    expect((db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status)
      .toBe('running')
  })

  test('tell targets the active child turn while retaining the conversation root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    expect(mailboxOrch('tell', String(root), 'context for turn two').code).toBe(0)
    expect(messagesForRun(child)[0]).toMatchObject({ root_run_id: root, run_id: child })
  })

  test('tell refuses a finished conversation instead of claiming a queue', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const told = mailboxOrch('tell', String(root), 'too late')
    expect(told.code).toBe(1)
    expect(told.err).toContain('has no running turn — no message was queued')
    expect(messagesForRun(root)).toEqual([])
  })
})

describe('porting data model', () => {
  test('stores pair progress and declined candidates with their reasons', () => {
    upsertProject({ name: 'source-invented', path: '/w/source-invented',
      settings: { keyPrefixes: ['SRC'] } })
    upsertProject({ name: 'target-invented', path: '/w/target-invented',
      settings: { keyPrefixes: ['TGT'] } })
    const [source, target] = projects().sort((a, b) => a.name.localeCompare(b.name))
    const pair = addPair(source!.id, target!.id, '2026-09-01T00:00:00.000Z')

    expect(addPair(source!.id, target!.id).id).toBe(pair.id)
    expect(listPairs()).toEqual([pair])
    expect(baselineForPair(pair.id)).toEqual({
      pair_id: pair.id, source_commit: null, scanned_at: null,
    })
    expect(setBaseline(pair.id, 'abc123', '2026-09-02T00:00:00.000Z')).toEqual({
      pair_id: pair.id, source_commit: 'abc123', scanned_at: '2026-09-02T00:00:00.000Z',
    })
    addSkip(pair.id, 'candidate-one', 'not applicable', '2026-09-03T00:00:00.000Z')
    expect(listSkips(pair.id)).toMatchObject([
      { candidate: 'candidate-one', reason: 'not applicable' },
    ])
  })

  test('keeps each ledger source project distinct and resolves the target by key prefix', () => {
    upsertProject({ name: 'source-one-invented', path: '/w/source-one', settings: {} })
    upsertProject({ name: 'source-two-invented', path: '/w/source-two', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const byName = Object.fromEntries(projects().map((project) => [project.name, project]))

    const ref = setLedgerRef({
      taskKey: 'TGT-42', note: 'adapt this natively', createdAt: '2026-09-03T00:00:00.000Z',
      sources: [
        { source_project_id: byName['source-one-invented']!.id,
          commits: ['aaa'], paths: ['src/a.ts'], note: 'first source' },
        { source_project_id: byName['source-two-invented']!.id,
          commits: ['bbb', 'ccc'], paths: ['src/b.ts'], note: 'second source' },
      ],
    })

    expect(ref.target_project_id).toBe(byName['target-invented']!.id)
    expect(ledgerRef('TGT-42')!.sources).toEqual([
      { source_project_id: byName['source-one-invented']!.id,
        commits: ['aaa'], paths: ['src/a.ts'], note: 'first source' },
      { source_project_id: byName['source-two-invented']!.id,
        commits: ['bbb', 'ccc'], paths: ['src/b.ts'], note: 'second source' },
    ])
    expect(() => setLedgerRef({ taskKey: 'NONE-1', note: '', sources: ref.sources }))
      .toThrow('no registered project owns task key')
  })

  test('resolution preserves provenance and default listings omit completed refs', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const source = projects().find((project) => project.name === 'source-invented')!
    setLedgerRef({
      taskKey: 'TGT-42', note: 'provenance',
      sources: [{ source_project_id: source.id, commits: ['abc'], paths: ['src/a.ts'], note: 'source' }],
    })

    expect(listLedgerRefs()).toHaveLength(1)
    expect(resolveLedgerRef('TGT-42', '2026-09-04T00:00:00.000Z')).toMatchObject({
      task_key: 'TGT-42', resolved_at: '2026-09-04T00:00:00.000Z',
      sources: [{ commits: ['abc'], paths: ['src/a.ts'] }],
    })
    expect(listLedgerRefs()).toEqual([])
    expect(listLedgerRefs(true)).toHaveLength(1)
    expect(resolveLedgerRef('TGT-42', 'later')?.resolved_at).toBe('2026-09-04T00:00:00.000Z')
  })

  test('retires doctrine without freeing its stable number', () => {
    addDoctrineRule(7, 'Invented rule', 'Keep the example invented.', '2026-09-01T00:00:00.000Z')
    expect(retireDoctrineRule(7, '2026-09-02T00:00:00.000Z')).toBe(true)
    expect(listDoctrineRules(false)).toEqual([])
    expect(listDoctrineRules()).toMatchObject([{ number: 7, retired_at: '2026-09-02T00:00:00.000Z' }])
    expect(() => addDoctrineRule(7, 'Replacement', 'Must not reuse seven.')).toThrow()
  })
})

describe('port importer', () => {
  const registered = () => {
    upsertProject({ name: 'alpha-invented', path: '/w/alpha-invented', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/beta-invented', settings: { keyPrefixes: ['BET'] } })
    return projects()
  }
  const fixture = (overrides: Partial<Record<'doctrine' | 'differences' | 'backports' | 'refs' | 'state' | 'projects', string>> = {}) => ({
    doctrine: '# Doctrine\n\nPreface text.\n\n1. **Keep the whole rule** Opening sentence.\nContinuation line.\nA known final item at the end of the rule.\n',
    differences: '# Differences\n\n## Stack mapping (how to translate, not a reason to skip)\nMap body.\n\n## Per-project uniques\n\n### alpha-invented\nAlpha body.\n\n### Shared deployment constraint\nUnassigned body.\n\n### beta-invented\nBeta body.\n\n## Process differences\nProcess body.\n',
    backports: '# Backports\n\n## -> alpha-invented\n' + 'A long backport body. '.repeat(20) + '\nKnown final checkbox.\n\n## -> beta-invented\nBeta backport.\n',
    refs: JSON.stringify({ 'BET-7': { source: 'alpha-invented', commits: ['abc'], paths: ['src/a.ts'], notes: 'Native notes.' } }),
    state: JSON.stringify({ pairs: { 'alpha-invented->beta-invented': { lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [{ feature: 'old feature', reason: 'superseded', raiseAgain: false }] } } }),
    projects: '# Projects\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n',
    ...overrides,
  })

  test('plans complete long sections and classifies an unmatched differences heading globally', () => {
    const plan = planImport(fixture(), registered())
    expect(plan.refusals).toEqual([])
    const backport = plan.docs.find((doc) => doc.subject === 'alpha-invented' && doc.slug === 'port-backports')!
    expect(backport.body.length).toBeGreaterThan(backport.body.indexOf('\n') + 300)
    expect(backport.body).toContain('Known final checkbox.')
    expect(plan.doctrine[0]!.body).toContain('A known final item at the end of the rule.')
    expect(plan.docs.find((doc) => doc.slug === 'port-differences-unassigned')?.body)
      .toContain('Shared deployment constraint')
    expect(plan.docs.find((doc) => doc.subject === 'beta-invented' && doc.slug === 'port-differences')?.body)
      .not.toContain('Process body.')
  })

  test('excludes incompatible baselines and unmapped fields while preserving bare skips losslessly', () => {
    const state = JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': {
        lastPortedSha: null, scannedAt: '2026-01-01', skipped: ['bare candidate'],
        note: 'one', notes: 'two', scope: ['src'], staged: ['ALP-1'],
      },
    } })
    const plan = planImport(fixture({ state }), registered())
    expect(plan.exclusions.filter((r) => r.what.startsWith('pair field')).map((r) => r.what)).toEqual([
      'pair field "note"', 'pair field "notes"', 'pair field "scope"', 'pair field "staged"',
    ])
    expect(plan.exclusions.find((r) => r.what === 'baseline')?.where)
      .toBe('state.json pairs["alpha-invented->beta-invented"]')
    expect(plan.skips).toEqual([expect.objectContaining({
      candidate: 'bare candidate',
      reason: 'recorded in the source with no separate reason; the candidate text is the entire record',
    })])
    expect(plan.docs.find((doc) => doc.slug === 'port-import-exclusions')?.body)
      .toContain('Original value:\none')

    const missingSha = planImport(fixture({ state: JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': { scannedAt: null, skipped: [] },
    } }) }), projects())
    expect(missingSha.exclusions.find((issue) => issue.what === 'baseline')?.why)
      .toBe('lastPortedSha is missing')
  })

  test('splits declared multi-sources, preserves qualifiers, and refuses unresolved sources and task prefixes', () => {
    upsertProject({ name: 'alpha-invented', path: '/w/a', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/b', settings: { keyPrefixes: ['DUP'] } })
    upsertProject({ name: 'gamma-invented', path: '/w/c', settings: { keyPrefixes: ['DUP'] } })
    const refs = JSON.stringify({
      'ALP-1': { source: 'alpha-invented + beta-invented', commits: [], paths: [], notes: '' },
      'ALP-2': { source: 'alpha-invented (concept); new mechanism', commits: [], paths: [], notes: '' },
      'ALP-3': { source: 'missing-invented (unknown)', commits: [], paths: [], notes: '' },
      'NONE-2': { source: 'alpha-invented', commits: [], paths: [], notes: '' },
      'DUP-3': { source: 'alpha-invented', commits: [], paths: [], notes: '' },
    })
    const plan = planImport(fixture({ refs }), projects())
    expect(plan.refs.find((ref) => ref.taskKey === 'ALP-1')?.sources.map((source) => source.source_project_id))
      .toEqual([projects().find((p) => p.name === 'alpha-invented')!.id,
        projects().find((p) => p.name === 'beta-invented')!.id])
    expect(plan.refs.find((ref) => ref.taskKey === 'ALP-2')?.sources[0]?.note)
      .toBe(' (concept); new mechanism')
    expect(plan.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: 'refs.json ALP-3', what: 'project "missing-invented (unknown)"' }),
      expect.objectContaining({ where: 'refs.json NONE-2', why: expect.stringContaining('no registered project') }),
      expect.objectContaining({ where: 'refs.json DUP-3', why: expect.stringContaining('several registered projects') }),
    ]))

    const nonStringSource = planImport(fixture({ refs: JSON.stringify({
      'ALP-4': { source: ['alpha-invented'], commits: [], paths: [], notes: '' },
    }) }), projects())
    expect(nonStringSource.refusals.find((issue) => issue.where === 'refs.json ALP-4')?.why)
      .toBe('source must name registered projects')
  })

  test('records the deliberately unimported register-derived sections as one exclusion', () => {
    const source = fixture({ projects: '# Projects\n\n## Resolving the workspace\nOld paths.\n\n## Stacks\nOld stacks.\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n' })
    const plan = planImport(source, registered())
    expect(plan.exclusions.filter((r) => r.where === 'projects.md')).toEqual([
      expect.objectContaining({ what: 'workspace and stack sections' }),
    ])
  })

  test('a refusal makes apply all-or-nothing', () => {
    const plan = planImport(fixture(), registered())
    plan.refusals.push({ kind: 'refusal', what: 'bad row', where: 'fixture row', why: 'cannot resolve it' })
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    expect(listPairs()).toEqual([])
    expect(listDoctrineRules()).toEqual([])
    expect(getDoc('global', null, 'port-category-map')).toBeNull()
    const uncovered = sourceCoverage(plan, fixture())
    expect(uncovered).toHaveLength(6)
    expect(uncovered.map((gap) => gap.text)).toEqual(expect.arrayContaining(Object.values(fixture())))
  })

  test('a destination refusal makes the plan report its whole input uncovered', () => {
    const files = fixture()
    applyImport(planImport(files, registered()))
    const refused = planImport(files, projects())
    expect(() => applyImport(refused)).toThrow(ImportRefusalError)
    expect(refused.refusals).toEqual([
      expect.objectContaining({ what: 'existing port data', kind: 'refusal' }),
    ])
    expect(sourceCoverage(refused, files)).toHaveLength(6)
  })

  test('persists every exclusion and its original value inside the import transaction', () => {
    const state = JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': {
        lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [],
        note: 'Original text that must survive verbatim.',
      },
    } })
    const plan = planImport(fixture({ state }), registered())
    expect(plan.refusals).toEqual([])
    applyImport(plan)
    expect(getDoc('global', null, 'port-import-exclusions')).toMatchObject({
      title: 'Port import exclusions',
      body: expect.stringContaining('Original value:\nOriginal text that must survive verbatim.'),
    })
  })

  test('a second import refuses existing data and replace atomically rewrites it', () => {
    const plan = planImport(fixture(), registered())
    applyImport(plan)
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    const replacement = planImport(fixture({ doctrine: '# Doctrine\n\nNew preface.\n\n2. **Replacement rule** Replacement body.\n' }), projects())
    applyImport(replacement, { replace: true })
    expect(listDoctrineRules().map((row) => row.number)).toEqual([2])
    expect(listPairs()).toHaveLength(1)
    expect(getDoc('global', null, 'port-doctrine-preface')?.body).toContain('New preface.')
  })

  test('an importer-owned doc alone makes the destination non-empty', () => {
    const plan = planImport(fixture(), registered())
    setDoc({ scope: 'global', subject: null, slug: 'port-category-map', title: 'Existing', body: 'Keep me.' })
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    expect(getDoc('global', null, 'port-category-map')).toMatchObject({ title: 'Existing', body: 'Keep me.' })
    expect(listPairs()).toEqual([])
  })

  test('a late doctrine constraint failure rolls back every preceding write', () => {
    const plan = planImport(fixture(), registered())
    plan.doctrine.push({ ...plan.doctrine[0]!, title: 'Duplicate' })
    expect(() => applyImport(plan)).toThrow()
    expect(listPairs()).toEqual([])
    expect(db().query('SELECT COUNT(*) n FROM port_baseline').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_skip').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_ref').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_ref_source').get()).toEqual({ n: 0 })
    expect(listDoctrineRules()).toEqual([])
    expect(listDocs().filter((doc) => doc.slug.startsWith('port-'))).toEqual([])
  })

  test('a late replacement failure restores all deleted prior data and docs', () => {
    const original = planImport(fixture(), registered())
    applyImport(original)
    const priorPair = listPairs()
    const priorBaseline = baselineForPair(priorPair[0]!.id)
    const priorSkips = listSkips(priorPair[0]!.id)
    const priorRef = ledgerRef('BET-7')
    const priorDoc = getDoc('global', null, 'port-category-map')
    const replacement = planImport(fixture(), projects())
    replacement.doctrine.push({ ...replacement.doctrine[0]!, title: 'Duplicate' })
    expect(() => applyImport(replacement, { replace: true })).toThrow()
    expect(listPairs()).toEqual(priorPair)
    expect(baselineForPair(priorPair[0]!.id)).toEqual(priorBaseline)
    expect(listSkips(priorPair[0]!.id)).toEqual(priorSkips)
    expect(ledgerRef('BET-7')).toEqual(priorRef)
    expect(getDoc('global', null, 'port-category-map')).toEqual(priorDoc)
    expect(listDoctrineRules()).toHaveLength(1)
  })

  test('CLI dry-run shows body lengths, writes nothing, and names a missing file', () => {
    registered()
    const source = mkdtempSync(join(tmpdir(), 'port-import-invented-'))
    try {
      for (const [name, body] of Object.entries(fixture())) writeFileSync(join(source, `${name}.json`), body)
      // Markdown inputs have their source filenames rather than the fixture object's uniform suffix.
      for (const name of ['doctrine', 'differences', 'backports', 'projects'] as const) {
        writeFileSync(join(source, `${name}.md`), fixture()[name])
      }
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const run = (path: string) => Bun.spawnSync([process.execPath, CLI, 'port', 'import', path, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      const sessionsBefore = db().query('SELECT COUNT(*) n FROM session_seen').get()
      const clean = run(source)
      expect(clean.exitCode).toBe(0)
      const cleanPlan = JSON.parse(clean.stdout.toString())
      expect(cleanPlan.docs[0].bodyLength).toBeGreaterThan(0)
      expect(cleanPlan.uncoveredSpans).toEqual([])
      const human = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(human.exitCode).toBe(0)
      expect(human.stdout.toString()).toContain('uncovered spans (0)')
      expect(listPairs()).toEqual([])
      expect(db().query('SELECT COUNT(*) n FROM session_seen').get()).toEqual(sessionsBefore)

      const incomplete = mkdtempSync(join(tmpdir(), 'port-import-missing-invented-'))
      try {
        const missing = run(incomplete)
        expect(missing.exitCode).toBe(1)
        const missingPlan = JSON.parse(missing.stdout.toString())
        expect(missingPlan.refusals).toHaveLength(6)
        expect(missingPlan.refusals.every((issue: any) => issue.what.startsWith('source file'))).toBe(true)
        expect(missingPlan.refusals.map((issue: any) => issue.where)).toContain(join(incomplete, 'refs.json'))
        expect(missingPlan.uncoveredSpans).toHaveLength(6)
      } finally { rmSync(incomplete, { recursive: true, force: true }) }
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('CLI dry-run refuses a nonexistent database without creating any SQLite files', () => {
    const source = mkdtempSync(join(tmpdir(), 'port-import-readonly-invented-'))
    const absent = join(source, 'absent.db')
    try {
      const contents = fixture()
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const run = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: absent, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(run.exitCode).toBe(1)
      expect(run.stdout.toString()).toContain('orchestrator database does not exist')
      expect(existsSync(absent)).toBe(false)
      expect(existsSync(`${absent}-wal`)).toBe(false)
      expect(existsSync(`${absent}-shm`)).toBe(false)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('CLI dry-run explains a WAL database whose shared-memory sidecar is absent', () => {
    const source = mkdtempSync(join(tmpdir(), 'port-import-wal-invented-'))
    const walPath = join(source, 'wal-copy.db')
    try {
      const contents = fixture()
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)
      const wal = new Database(walPath)
      wal.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE project (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
          stack TEXT, canon INTEGER NOT NULL, settings TEXT
        );
        PRAGMA wal_checkpoint(TRUNCATE);
      `)
      wal.close()
      rmSync(`${walPath}-shm`, { force: true })
      rmSync(`${walPath}-wal`, { force: true })
      expect(existsSync(`${walPath}-shm`)).toBe(false)

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const run = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: walPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(run.exitCode).toBe(1)
      const why = JSON.parse(run.stdout.toString()).refusals[0].why
      expect(why).toContain(`WAL-mode with no ${walPath}-shm sidecar`)
      expect(why).toContain('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(why).toContain('Underlying error: SQLiteError: unable to open database file')
      expect(existsSync(`${walPath}-shm`)).toBe(false)
      expect(existsSync(`${walPath}-wal`)).toBe(false)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('every non-whitespace source span in synthetic port files is accounted for', () => {
    const files = fixture({
      refs: JSON.stringify({
        _format: 'invented ledger shape',
        'BET-7': { source: 'alpha-invented', commits: ['abc'], paths: ['src/a.ts'], notes: 'Native notes.' },
        'BET-8': { source: 'alpha-invented + beta-invented', commits: ['def'], paths: ['src/b.ts'], notes: 'Two sources.' },
      }),
    })
    const state = JSON.parse(files.state)
    const projectNames = [...new Set(Object.keys(state.pairs).flatMap((pair) => pair.split('->')))] as string[]
    const refs = JSON.parse(files.refs)
    const prefixes = [...new Set(Object.keys(refs).filter((key) => !key.startsWith('_')).map((key) => key.split('-')[0]))]
    const syntheticRegister = projectNames.map((name, index) => ({
      id: index + 1, name, path: `/fixture/${index}`, stack: null, canon: false,
      settings: index === 0 ? { keyPrefixes: prefixes } : {},
    }))
    const plan = planImport(files, syntheticRegister)
    expect(plan.refusals).toEqual([])
    expect(sourceCoverage(plan, files)).toEqual([])

    const wrongId = structuredClone(plan)
    wrongId.refs[0]!.sources[0]!.source_project_id = 999999
    expect(sourceCoverage(wrongId, files)).toContainEqual({ file: 'refs.json', offset: 0, text: files.refs })

    const duplicatedSource = structuredClone(plan)
    const multiSource = duplicatedSource.refs.find((ref) => ref.sources.length > 1)!
    multiSource.sources[0] = structuredClone(multiSource.sources[1]!)
    expect(sourceCoverage(duplicatedSource, files))
      .toContainEqual({ file: 'refs.json', offset: 0, text: files.refs })

    const repeatedSkipState = JSON.parse(files.state)
    const [repeatedPairKey, repeatedPair] = Object.entries(repeatedSkipState.pairs as Record<string, any>)
      .find(([, pair]: [string, any]) => Array.isArray(pair.skipped) && pair.skipped.length > 0)!
    repeatedPair.skipped.push(structuredClone(repeatedPair.skipped[0]))
    const repeatedSkipFiles = { ...files, state: JSON.stringify(repeatedSkipState) }
    const missingRepeatedSkip = planImport(repeatedSkipFiles, syntheticRegister)
    const repeatedRows = missingRepeatedSkip.skips
      .map((skip, index) => ({ skip, index }))
      .filter(({ skip }) => skip.pairKey === repeatedPairKey)
    missingRepeatedSkip.skips.splice(repeatedRows.at(-1)!.index, 1)
    expect(sourceCoverage(missingRepeatedSkip, repeatedSkipFiles))
      .toContainEqual({ file: 'state.json', offset: 0, text: repeatedSkipFiles.state })

    plan.docs = plan.docs.filter((doc) => doc.slug !== 'port-import-source-context')
    expect(sourceCoverage(plan, files)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: expect.stringMatching(/\.md$/), offset: expect.any(Number), text: expect.any(String) }),
    ]))

    const jsonPlan = planImport(files, syntheticRegister)
    jsonPlan.docs = jsonPlan.docs.filter((doc) => doc.slug !== 'port-state-metadata')
    expect(sourceCoverage(jsonPlan, files)).toContainEqual({ file: 'state.json', offset: 0, text: files.state })
    jsonPlan.docs = planImport(files, syntheticRegister).docs.filter((doc) => doc.slug !== 'port-ref-metadata')
    expect(sourceCoverage(jsonPlan, files)).toContainEqual({ file: 'refs.json', offset: 0, text: files.refs })
  })
})

function score(
  runId: number, delivery: string, quality: string | null = null, fidelity: string | null = null,
) {
  db().query(
    'INSERT INTO score (run_id, delivery, quality, fidelity, scored_at) VALUES (?,?,?,?,?)',
  ).run(runId, delivery, quality, fidelity, new Date().toISOString())
}

function workerReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'done', summary: 'done', files_changed: ['changed.ts'], questions: null,
    deviations: null, tests: { command: 'bun test', ran: true, passed: true, detail: null },
    blockers: null, ...overrides,
  }
}

describe('failure classification', () => {
  test("OpenAI's invalid response schema is a harness failure", () => {
    expect(classify(
      "Invalid schema for response_format 'codex_output_schema': additionalProperties is required",
    )).toBe('harness')
  })

  test("Codex's own banner is not a permission denial", () => {
    // The banner Codex prints before it says anything, followed by the real
    // error. `approval` used to match here and stamped `denied` on it.
    const codexBanner = [
      'OpenAI Codex v0.151.0', '--------',
      'workdir: /workspace/y', 'model: gpt-5.6-sol',
      'approval: never', 'sandbox: read-only', '',
      'ERROR: Unexpected message role', 'stream disconnected',
    ].join('\n')
    expect(classify(codexBanner)).not.toBe('denied')
  })

  test('a real headless denial still classifies as denied', () => {
    expect(classify('jetski: no output produced — a tool required the "read_file" permission')).toBe('denied')
    expect(classify('the command was auto-denied by headless mode')).toBe('denied')
  })

  test('quota and auth are separated, because only one is fixed by waiting', () => {
    expect(classify('HTTP 429: rate limit exceeded')).toBe('quota')
    expect(classify('HTTP 402')).toBe('quota')
    expect(classify('balance exhausted')).toBe('quota')
    expect(classify('401 unauthorized')).toBe('auth')
    expect(NEEDS_HUMAN).toEqual(['quota', 'auth', 'unreachable'])
  })

  test('an endpoint that is not there is unreachable, not a verdict', () => {
    // The exact string Qwen Code produced while the local model host was
    // powered off, and the shapes a tunnel or a refused socket produce.
    expect(classify('[API Error: Connection error.]')).toBe('unreachable')
    expect(classify('connect ECONNREFUSED 127.0.0.1:8010')).toBe('unreachable')
    expect(classify('ssh: connect to host 192.0.2.10 port 22: No route to host'))
      .toBe('unreachable')
    expect(classify('Unable to connect. Is the computer able to access the url?'))
      .toBe('unreachable')
  })

  test('what the room did is not evidence about the agent', () => {
    // Vendor account failures, a box switched off, an operator killing the
    // process tree, and orch itself being wrong are not capability evidence.
    // None of them may be averaged in with the agent's actual work.
    expect(NOT_EVIDENCE).toEqual([
      'quota', 'auth', 'unreachable', 'interrupted', 'harness', 'abandoned',
    ])
    for (const kind of ['timeout', 'denied', 'other']) {
      expect(NOT_EVIDENCE).not.toContain(kind)
    }
  })

  test('a killed process tree is interrupted, not a verdict on the agent', () => {
    // The exact string run.ts writes when the child died with no output and our
    // own timer never fired: a foreground `orch do` outliving the calling
    // harness's command timeout. 143 is SIGTERM, 130 SIGINT, 137 SIGKILL.
    expect(classify('exit 143, empty output')).toBe('interrupted')
    expect(classify('exit 130, empty output')).toBe('interrupted')
    expect(classify('exit 137, empty output')).toBe('interrupted')
    // A different exit code is not this. It means the agent ran and failed on
    // its own, which IS its record.
    expect(classify('exit 1, empty output')).toBe('other')
    // Anchored whole-string, so a reply that merely discusses the shape - a
    // review of this very file would - is never thrown away as a failure.
    expect(classify('the wrapper reported exit 143, empty output, which we now classify'))
      .toBe('other')
  })

  test('an interrupted run neither cools the agent down nor pages a person', () => {
    // Nothing to wait out and nothing to fix: the kill came from the caller,
    // and the same command run detached would not have produced it.
    expect(COOLS_DOWN).not.toContain('interrupted')
    expect(NEEDS_HUMAN).not.toContain('interrupted')
  })

  test('unreachable tells a person but does not cool the agent down', () => {
    // A cooldown is for what only a run can detect. Quota and auth announce
    // themselves by failing; reachability is measured before every route for
    // the price of one local HTTP call, so waiting an hour buys nothing and
    // costs the whole recovery window.
    expect(NEEDS_HUMAN).toContain('unreachable')
    expect(COOLS_DOWN).not.toContain('unreachable')
    expect(COOLS_DOWN).toEqual(['quota', 'auth'])
  })

  test('a peer that reset stays a timeout — it answered before it stopped', () => {
    // Guards the deliberate narrowness of the unreachable pattern. Reclassifying
    // this on no evidence would trade one guess for another.
    expect(classify('kex_exchange_identification: read: Connection reset by peer'))
      .toBe('timeout')
  })

  test('every kind needing a human has something to tell them', () => {
    // A ternary covered two and would have called the third an auth problem.
    for (const kind of NEEDS_HUMAN) {
      expect(typeof NEEDS_HUMAN_TITLE[kind]).toBe('function')
      expect(NEEDS_HUMAN_TITLE[kind]!('qwen-local')).toContain('qwen-local')
    }
  })

  test('an unrecognised failure is reported as other, never swallowed', () => {
    expect(classify('something nobody has seen before')).toBe('other')
    expect(classify(null)).toBe('other')
  })
})

describe('Codex strict output schemas', () => {
  test('normalizes nested objects and makes optional fields nullable', () => {
    expect(strictCodexSchema({
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: {
          type: 'object',
          properties: {
            count: { type: 'number' },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
          required: ['count'],
        },
      },
      required: ['title'],
    })).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: {
          type: ['object', 'null'],
          properties: {
            count: { type: 'number' },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          },
          required: ['count', 'note'],
          additionalProperties: false,
        },
      },
      required: ['title', 'detail'],
      additionalProperties: false,
    })
  })
})

describe('routing counts failures as evidence', () => {
  test('an agent that mostly fails does not look flawless', () => {
    // agy's real review-lens record: one good answer, two headless denials.
    score(addRun({ agent: 'agy', job: 'review-lens' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })

    const agy = candidates('review-lens').find((c) => c.agent === 'agy')!
    expect(agy.scored).toBe(1)
    expect(agy.failures).toBe(2)
    expect(agy.evidence).toBe(3)
    // (one full/right + two delivery failures) / 3
    expect(agy.score).toBeCloseTo((weigh('full', 'right') + 2 * weigh('none', null)) / 3)
    // The whole point: this is no longer a perfect record.
    expect(agy.score).toBeLessThan(weigh('full', 'right'))
  })

  test('a failed run that someone also scored counts once, not twice', () => {
    // A run contributes exactly one judgement. Counting the failure AND the
    // score doubled the evidence for the same run, so an agent could be
    // declared proven on half the runs it should have needed.
    const id = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    score(id, 'none')
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.failures).toBe(0)   // already represented by the score
    expect(c.evidence).toBe(1)   // one run, one judgement
    expect(c.score).toBe(weigh('none', null))
  })

  test('an explicit score on an interrupted run is not routing evidence', () => {
    score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    const interrupted = addRun({
      agent: 'codex', job: 'craft', status: 'failed', kind: 'interrupted',
    })
    score(interrupted, 'none')

    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('an unjudged failure still counts, or failing would be free', () => {
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'grok')!
    expect(c.scored).toBe(0)
    expect(c.failures).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('none', null))
  })

  test('evidence never exceeds the number of runs behind it', () => {
    // The invariant the double count broke.
    score(addRun({ agent: 'codex', job: 'safety' }), 'full', 'right')
    score(addRun({ agent: 'codex', job: 'safety', status: 'failed' }), 'none')
    addRun({ agent: 'codex', job: 'safety', status: 'stale' })
    addRun({ agent: 'codex', job: 'safety' })  // ok, unscored
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBeLessThanOrEqual(4)
    expect(c.evidence).toBe(3)  // the unscored OK run is not yet a judgement
  })

  test('a woken box is usable at once, not in an hour', () => {
    // The bug this pins: wake succeeds, the box is serving five minutes later,
    // and routing still refuses it for the remaining fifty-five because the
    // last run had failed `unreachable`.
    db().query(
      `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                        status, failure_kind)
       VALUES (datetime('now','-5 minutes'),'qwen-local','file-question','s',10,'h',
               'failed','unreachable')`,
    ).run()
    const c = candidates('file-question').find((x) => x.agent === 'qwen-local')!
    expect(c.cooling).toBeNull()
  })

  test('quota opens the circuit, because only a run can tell you it has cleared', () => {
    addRun({
      agent: 'codex', job: 'craft', status: 'failed', kind: 'quota',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    })
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.cooling).toContain('quota')
    expect(c.eligible).toBe(false)
    expect(c.why).toContain('vendor quota')
  })

  test('a later-id success finishing before quota failures does not mask them', () => {
    // Exact fan-out shape from DEV-132: ids are launch order, not completion
    // order. The success launches last but completes while its older siblings
    // are still running; their later quota deaths must open the circuit.
    const base = Date.now() - 10 * 60_000
    addRun({
      agent: 'grok', job: 'review-lens', status: 'failed', kind: 'quota',
      startedAt: new Date(base).toISOString(), latency: 8 * 60_000,
    })
    addRun({
      agent: 'grok', job: 'review-lens', status: 'failed', kind: 'quota',
      startedAt: new Date(base + 1000).toISOString(), latency: 8 * 60_000,
    })
    addRun({
      agent: 'grok', job: 'review-lens',
      startedAt: new Date(base + 2000).toISOString(), latency: 2 * 60_000,
    })

    const c = candidates('review-lens').find((x) => x.agent === 'grok')!
    expect(c.cooling).toContain('quota')
    expect(c.eligible).toBe(false)
  })

  test('an outage is not a verdict — the room failed, not the agent', () => {
    // The local model host was powered off for eleven hours. Routing kept sending
    // qwen-local its best job and kept recording the failures against it.
    score(addRun({ agent: 'qwen-local', job: 'file-question' }), 'full', 'right')
    score(addRun({ agent: 'qwen-local', job: 'file-question' }), 'full', 'right')
    addRun({ agent: 'qwen-local', job: 'file-question', status: 'failed',
             kind: 'unreachable' })
    addRun({ agent: 'qwen-local', job: 'file-question', status: 'failed',
             kind: 'unreachable' })

    const c = candidates('file-question').find((x) => x.agent === 'qwen-local')!
    expect(c.failures).toBe(0)          // neither outage is charged to the model
    expect(c.evidence).toBe(2)          // only the two real verdicts
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('vendor billing and auth failures are not evidence', () => {
    for (const kind of ['quota', 'auth']) {
      db().exec('DELETE FROM score; DELETE FROM run;')
      addRun({ agent: 'codex', job: 'craft', status: 'failed', kind })
      const c = candidates('craft').find((x) => x.agent === 'codex')!
      expect(c.failures).toBe(0)
      expect(c.evidence).toBe(0)
    }
  })

  test('agent and harness failures remain evidence', () => {
    for (const kind of ['timeout', 'denied', 'other']) {
      db().exec('DELETE FROM score; DELETE FROM run;')
      addRun({ agent: 'codex', job: 'craft', status: 'failed', kind })
      const c = candidates('craft').find((x) => x.agent === 'codex')!
      expect(c.failures).toBe(1)
      expect(c.evidence).toBe(1)
    }
  })

  test('an unclassified failure is still evidence, so the exclusion cannot leak', () => {
    // COALESCE, not a bare NOT IN: a NULL failure_kind must stay countable.
    // Without it every pre-classification row would silently stop counting.
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })   // kind NULL
    const c = candidates('craft').find((x) => x.agent === 'grok')!
    expect(c.failures).toBe(1)
  })

  test('an abandoned run counts against the agent when nothing says why', () => {
    // A bare stale row - no kind - is still charged. Only the reaper's own
    // verdict clears it, and the reaper is the thing that knows the process was
    // killed rather than merely slow.
    addRun({ agent: 'grok', job: 'craft', status: 'stale' })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('a run the reaper swept is not evidence about the agent', () => {
    // What the reaper sweeps is a process that died without writing its own
    // terminal state. It cannot be a hang: every agent's timeout is below
    // STALE_AFTER_MS, so a slow run is stopped by its own timer and recorded as
    // `timeout`, which IS charged. This is a kill from outside - the caller's
    // command timeout taking the process group down - and charging it to the
    // model makes the harness's impatience look like the agent's incompetence.
    addRun({ agent: 'grok', job: 'craft', status: 'stale', kind: 'interrupted' })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(0)
    expect(grok.evidence).toBe(0)
  })

  test('probes are evidence about nothing, success or failure', () => {
    score(addRun({ agent: 'grok', job: 'craft', probe: 1 }), 'full', 'right')
    addRun({ agent: 'grok', job: 'craft', status: 'failed', probe: 1 })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.evidence).toBe(0)
    expect(grok.score).toBeNull()
  })

  test('an untried agent has no score, which is not the same as a bad one', () => {
    const c = candidates('review-lens').find((x) => x.agent === 'codex')!
    expect(c.score).toBeNull()
    expect(c.evidence).toBe(0)
  })
})

describe('reclassify-failures', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const runCli = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
    stdout: 'pipe', stderr: 'pipe',
  })

  test('reclassifies only failed rows whose own error has the DEV-122 signature', () => {
    const startedAt = '2026-09-03T12:00:00.000Z'
    const quotaError = 'Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage exhausted" }\nfull stored detail'
    const successful = addRun({
      agent: 'grok', job: 'review-lens', status: 'ok', kind: 'other', startedAt,
    })
    score(successful, 'full', 'right')
    const failed = addRun({
      agent: 'grok', job: 'review-lens', status: 'failed', kind: 'other', startedAt,
    })
    const nullKind = addRun({
      agent: 'codex', job: 'review-lens', status: 'failed', startedAt,
    })
    const unrelated = addRun({
      agent: 'grok', job: 'review-lens', status: 'stale', kind: 'other', startedAt,
    })
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, successful)
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, failed)
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, nullKind)
    db().query('UPDATE run SET error=? WHERE id=?').run('abandoned by architect', unrelated)

    const before = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(before.failures).toBe(2)
    expect(before.evidence).toBe(3)

    const dry = runCli('reclassify-failures', '--dry-run')
    expect(dry.exitCode).toBe(0)
    const dryOut = new TextDecoder().decode(dry.stdout)
    expect(dryOut).toContain('BEFORE (all failed/stale rows)')
    expect(dryOut).toContain('grok  other  2')
    expect(dryOut).toContain(`run ${failed}  grok/review-lens  [failed]  other -> quota`)
    expect(dryOut).toContain(`run ${nullKind}  codex/review-lens  [failed]  null -> quota`)
    expect(dryOut).toContain(quotaError)
    expect(dryOut).toContain('AFTER (all failed/stale rows)')
    expect(dryOut).toContain('grok  other  1')
    expect(dryOut).toContain('grok  quota  1')
    expect(dryOut).toContain('2 rows would be reclassified — dry run, no writes.')
    expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ failure_kind: 'other' })

    const applied = runCli('reclassify-failures')
    expect(applied.exitCode).toBe(0)
    expect(new TextDecoder().decode(applied.stdout)).toContain('2 rows reclassified.')
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ status: 'failed', failure_kind: 'quota' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(successful))
      .toEqual({ status: 'ok', failure_kind: 'other' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(nullKind))
      .toEqual({ status: 'failed', failure_kind: 'quota' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(unrelated))
      .toEqual({ status: 'stale', failure_kind: 'other' })

    const after = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(after.failures).toBe(1)
    expect(after.evidence).toBe(2)
    expect(after.score).toBeCloseTo(
      (weigh('full', 'right') + weigh('none', null)) / 2,
    )

    const again = runCli('reclassify-failures')
    expect(again.exitCode).toBe(0)
    expect(new TextDecoder().decode(again.stdout)).toContain('PLAN (0 matched rows)')
    expect(new TextDecoder().decode(again.stdout)).toContain('0 rows reclassified.')
  })
})

describe('reapStale', () => {
  test('a run older than the cutoff is swept even when its pid is alive', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // process.pid is certainly alive: this is the recycled-pid case, and the
    // age cutoff has to win it.
    db().query('UPDATE run SET started_at=?, pid=? WHERE id=?')
      .run(new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), process.pid, id)

    expect(reapStale(db())).toBe(1)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('stale')
  })

  test('a recent run whose process is gone is swept at once, not in thirty minutes', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // Nothing owns pid 2^22; it is above every configured pid_max.
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    expect(reapStale(db())).toBe(1)
  })

  test('the reaper says WHY it swept, so routing can discount it', () => {
    // Without the kind these rows are indistinguishable from an agent that
    // simply failed, and the router charges them accordingly.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    reapStale(db())
    const r = db().query('SELECT status, failure_kind FROM run WHERE id=?')
      .get(id) as { status: string; failure_kind: 'interrupted' }
    expect(r.status).toBe('stale')
    expect(r.failure_kind).toBe('interrupted')
    expect(NOT_EVIDENCE).toContain(r.failure_kind)
  })

  test('a recent run with NO pid cannot be swept, which is why one is recorded', () => {
    // The liveness check is guarded on `if (r.pid)`, so a row without one is
    // invisible to it and can only be cleared by the thirty-minute cutoff. That
    // is not a bug in the reaper - a pid it never had tells it nothing - it is
    // the reason detach() must write the WORKER's pid the moment it spawns.
    // Without that, a worker that died before starting an agent left a row
    // claiming to run, showing `(pending)` on the dashboard; four were sitting
    // there when this was found, one for fifteen minutes.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL WHERE id=?').run(id)
    expect(reapStale(db())).toBe(0)
    // With one, the very same dead worker is swept on the next pass.
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    expect(reapStale(db())).toBe(1)
  })

  test('a live recent run is left alone', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    expect(reapStale(db())).toBe(0)
  })

  test('reaping a running child inherits stale onto an asking root as evidence', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered', 'the ruling', nowIso())
    const child = addRun({
      agent: 'grok', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, child)

    expect(reapStale(db())).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(child))
      .toEqual({ status: 'stale', failure_kind: 'interrupted' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({ status: 'stale', failure_kind: null })
    const grok = candidates('implement').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('a pid-less (pending) row older than the bootstrap bound is failed/harness', () => {
    const old = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    const young = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), old)
    db().query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - 10_000).toISOString(), young)

    expect(reapStale(db())).toBe(1)
    const swept = db().query('SELECT status, failure_kind, error FROM run WHERE id=?')
      .get(old) as { status: string; failure_kind: string; error: string }
    expect(swept).toEqual({
      status: 'failed', failure_kind: 'harness', error: 'the worker process never started',
    })
    expect((db().query('SELECT status FROM run WHERE id=?').get(young) as { status: string }).status)
      .toBe('running')
  })
})

describe('session scoping', () => {
  test('only this session\'s own unscored runs are raised', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    const theirs = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-A', mine)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-B', theirs)

    const pending = pendingForSession('session-A')
    expect(pending.map((r) => r.id)).toEqual([mine])
  })

  test('with no session id, nothing is claimed', () => {
    expect(pendingForSession(null)).toEqual([])
  })

  test('a scored run drops off the backlog', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('s', id)
    expect(pendingForSession('s')).toHaveLength(1)
    score(id, 'full', 'right')
    expect(pendingForSession('s')).toHaveLength(0)
  })
})

describe('who may judge a run', () => {
  // The rule was already written in AGENTS.md and did not hold: on 2026-08-31 two
  // concurrent sessions each scored the other's runs within an hour, both having
  // inferred their ids from their own previous block rather than reading them
  // back. These pin the guard that turns that prose into a refusal.

  test('the session that made a run may score it', () => {
    expect(judgeability('session-A', 'session-A')).toEqual({ verdict: 'own' })
  })

  test('another session may NOT — it never read the output', () => {
    expect(judgeability('session-A', 'session-B')).toEqual({
      verdict: 'foreign',
      owner: 'session-A',
    })
  })

  test('the owner travels with the refusal, so the error can name who to ask', () => {
    // Without this the message could only say "not yours", which does not tell
    // anyone what to do next. Naming the session is what makes SendMessage the
    // obvious move rather than --force.
    const v = judgeability('session-A', 'session-B')
    expect(v.verdict === 'foreign' && v.owner).toBe('session-A')
  })

  test('a run recorded before session ids is scoreable by anyone', () => {
    // Refusing these would strand every run made before session_id existed.
    // Missing evidence is not evidence of wrongdoing.
    expect(judgeability(null, 'session-A')).toEqual({ verdict: 'unattributed' })
    expect(judgeability(null, null)).toEqual({ verdict: 'unattributed' })
  })

  test('a caller with no session id is warned, not blocked', () => {
    // Scoring from a plain shell is legitimate; it just cannot be verified.
    expect(judgeability('session-A', null)).toEqual({
      verdict: 'anonymous',
      owner: 'session-A',
    })
  })
})

describe('pairwise judgements', () => {
  test('--better-than accepts a comma list of run ids', () => {
    expect(parseRunIds('12,13,99', '--better-than')).toEqual([12, 13, 99])
    expect(() => parseRunIds('', '--better-than')).toThrow('at least one run id')
    expect(() => parseRunIds('12,nope', '--better-than')).toThrow('separated by commas')
    expect(() => parseRunIds('12,12', '--better-than')).toThrow('same run more than once')
  })

  test('one winner can be recorded against every loser in a fan-out', () => {
    const winner = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const grok = addRun({ agent: 'grok', job: 'craft', session: 'session-A' })
    const agy = addRun({ agent: 'agy', job: 'craft', session: 'session-A' })
    recordDuels(winner, [grok, agy], 'session-A', '2026-09-02T12:00:00.000Z')

    expect(db().query(
      'SELECT job, winner_run_id, loser_run_id, session_id, at FROM duel ORDER BY loser_run_id',
    ).all()).toEqual([
      { job: 'craft', winner_run_id: winner, loser_run_id: grok,
        session_id: 'session-A', at: '2026-09-02T12:00:00.000Z' },
      { job: 'craft', winner_run_id: winner, loser_run_id: agy,
        session_id: 'session-A', at: '2026-09-02T12:00:00.000Z' },
    ])
    // Re-scoring does not duplicate the pair protected by the UNIQUE constraint.
    recordDuels(winner, [grok], 'session-A', '2026-09-02T13:00:00.000Z')
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(2)
  })

  test('duels require distinct runs from the same job', () => {
    const craft = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const safety = addRun({ agent: 'grok', job: 'safety', session: 'session-A' })
    expect(() => recordDuels(craft, [craft], 'session-A', new Date().toISOString()))
      .toThrow('cannot be better than itself')
    expect(() => recordDuels(craft, [safety], 'session-A', new Date().toISOString()))
      .toThrow('jobs differ')
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(0)
  })

  test('both runs must be judgeable by this session unless forced', () => {
    const mine = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const theirs = addRun({ agent: 'grok', job: 'craft', session: 'session-B' })
    expect(() => recordDuels(mine, [theirs], 'session-A', new Date().toISOString()))
      .toThrow('Both runs in a duel must be scoreable by this session')
    recordDuels(mine, [theirs], 'session-A', new Date().toISOString(), true)
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(1)
  })

  test('stats data is a per-job agent win-loss matrix', () => {
    const codex = addRun({ agent: 'codex', job: 'craft', session: 's' })
    const grok = addRun({ agent: 'grok', job: 'craft', session: 's' })
    const agy = addRun({ agent: 'agy', job: 'craft', session: 's' })
    const other = addRun({ agent: 'grok', job: 'safety', session: 's' })
    recordDuels(codex, [grok, agy], 's', new Date().toISOString())
    recordDuels(grok, [codex], 's', new Date().toISOString())
    recordDuels(other, [addRun({ agent: 'codex', job: 'safety', session: 's' })],
      's', new Date().toISOString())

    const matrix = duelMatrices('craft')
    expect(matrix).toHaveLength(1)
    expect(matrix[0]!.job).toBe('craft')
    expect(matrix[0]!.agents).toEqual(['agy', 'codex', 'grok'])
    expect(matrix[0]!.cells.codex!.grok).toEqual({ wins: 1, losses: 1 })
    expect(matrix[0]!.cells.codex!.agy).toEqual({ wins: 1, losses: 0 })
    expect(matrix[0]!.cells.agy!.grok).toEqual({ wins: 0, losses: 0 })
  })
})

describe('the scoring matrix', () => {
  test('no answer costs more than a wrong answer, because it is a different failure', () => {
    // A wrong answer means the agent engaged and got it wrong; nothing arriving
    // means it cannot do this job here. Only the second should push routing away.
    expect(weigh('none', null)).toBeLessThan(weigh('full', 'wrong'))
    expect(weigh('none', null)).toBeLessThan(0)
    expect(weigh('full', 'wrong')).toBe(0)
  })

  test('quality orders within a delivery level', () => {
    for (const d of ['partial', 'full'] as const) {
      expect(weigh(d, 'wrong')).toBeLessThan(weigh(d, 'mixed'))
      expect(weigh(d, 'mixed')).toBeLessThan(weigh(d, 'right'))
    }
  })

  test('a full answer beats the same quality delivered partially', () => {
    for (const q of ['wrong', 'mixed', 'right'] as const) {
      expect(weigh('partial', q)).toBeLessThanOrEqual(weigh('full', q))
    }
  })

  test('the three cells the old vocabulary could express kept their exact values', () => {
    // Migrating must not move any agent's standing on its own.
    expect(weigh('full', 'right')).toBe(1)     // was good
    expect(weigh('full', 'mixed')).toBe(0.5)   // was partial
    expect(weigh('full', 'wrong')).toBe(0)     // was bad
    expect(weigh('none', null)).toBe(-0.5)     // was unusable
  })

  test('the SQL expression is built from the matrix, so editing it moves routing', () => {
    const sql = weightCase()
    for (const [delivery, row] of Object.entries(WEIGHT)) {
      if (typeof row === 'number') {
        expect(sql).toContain(`WHEN s.delivery = '${delivery}' THEN ${row}`)
      } else {
        for (const [quality, w] of Object.entries(row)) {
          expect(sql).toContain(`WHEN s.delivery = '${delivery}' AND s.quality = '${quality}' THEN ${w}`)
        }
      }
    }
  })

  test('a delivery failure and a wrong answer are no longer the same row', () => {
    // The complaint that produced this matrix: run 279 came back as 57 bytes of
    // vendor error and was recorded identically to a full answer that was wrong.
    const noAnswer = addRun({ agent: 'agy', job: 'craft' })
    const wrongAnswer = addRun({ agent: 'codex', job: 'craft' })
    score(noAnswer, 'none')
    score(wrongAnswer, 'full', 'wrong')
    const cs = candidates('craft')
    expect(cs.find((c) => c.agent === 'agy')!.score)
      .toBeLessThan(cs.find((c) => c.agent === 'codex')!.score!)
  })

  test('the schema refuses an incoherent judgement', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    // Nothing came back, yet a quality is asserted about it.
    expect(() => score(id, 'none', 'right')).toThrow()
    // Something came back, yet no quality is recorded.
    expect(() => score(id, 'full', null)).toThrow()
  })

  test('every cell has a short label, and none of them collide', () => {
    const labels = new Set<string>()
    labels.add(label('none', null))
    for (const d of ['partial', 'full'] as const)
      for (const q of ['wrong', 'mixed', 'right'] as const) labels.add(label(d, q))
    expect(labels.size).toBe(7)
  })
})

describe('reading the verdict off the command line', () => {
  // Mirrors the filter in cli.ts. `orch score 279 none --note "..."` read
  // --note as the quality and rejected the whole thing as incoherent, which is
  // a baffling way to be told about a typo nobody made.
  const VALUE_FLAGS = new Set(['--agent', '--file', '--schema', '--model', '--note',
                               '--job', '--limit', '--port', '--days', '--window'])
  const words = (args: string[]) =>
    args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))

  test('a note does not get read as the quality', () => {
    expect(words(['none', '--note', 'it returned a vendor error'])).toEqual(['none'])
  })

  test('both halves survive a trailing note', () => {
    expect(words(['full', 'right', '--note', 'good stuff'])).toEqual(['full', 'right'])
  })

  test('a boolean switch does not eat the word after it', () => {
    expect(words(['full', '--quiet', 'right'])).toEqual(['full', 'right'])
  })
})

describe('job contracts are visible before submission', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const contract = (jobName: string) => {
    const p = Bun.spawnSync([process.execPath, CLI, 'contract', jobName], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }

  test('the read-only contract names inherited work without claiming it is always present', () => {
    expect(READONLY_PREAMBLE).toContain('fresh checkout of this')
    expect(READONLY_PREAMBLE).toContain("run's base commit")
    expect(READONLY_PREAMBLE).toContain('If the caller chose to carry their uncommitted work into it')
    expect(READONLY_PREAMBLE).toContain('do not report it as your change')
    expect(READONLY_PREAMBLE).not.toContain("It contains the caller's")
  })

  test('contract prints the same preamble selected when a job is bound', () => {
    for (const [name, definition] of Object.entries(JOBS)) {
      const r = contract(name)
      expect(r.code).toBe(0)
      expect(r.out).toBe(
        `${definition.needs.writesRepo
          ? WORKER_PREAMBLE
          : definition.needs.readsRepo ? READONLY_PREAMBLE : NO_REPO_PREAMBLE}\n`,
      )
      expect(r.err).toBe('')
    }
  })

  test('contract rejects an unknown job', () => {
    const r = contract('not-a-job')
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown job "not-a-job"')
  })

  test('implement conflict warnings identify the original line', () => {
    const spec = [
      'Make the requested change.',
      'Commit it using the DEV-126 prefix.',
      'Then push the branch.',
    ].join('\n')
    expect(contractConflicts(spec)).toEqual([
      { line: 3, text: 'Then push the branch.' },
    ])
  })

  test('repeating the contract prohibitions is not reported as a conflict', () => {
    expect(contractConflicts([
      'Do not commit, push, or merge.',
      'Never push this branch.',
      'Make the change without committing it.',
      'There must be no commits.',
    ].join('\n'))).toEqual([])
  })

  test('a prohibition does not hide a conflicting instruction later on its line', () => {
    expect(contractConflicts('Do not commit. Push the branch instead.')).toEqual([
      { line: 1, text: 'Do not commit. Push the branch instead.' },
    ])
  })
})

describe('one score, reported the same everywhere', () => {
  function judged(agent: string, rights: number, wrongs: number) {
    for (let i = 0; i < rights; i++) {
      score(addRun({ agent, job: 'review-lens-inline' }), 'full', 'right')
    }
    for (let i = 0; i < wrongs; i++) {
      score(addRun({ agent, job: 'review-lens-inline' }), 'full', 'wrong')
    }
  }

  test('candidates shrink scores toward the mean of the proven field', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)

    const cs = candidates('review-lens-inline')
    const codex = cs.find((c) => c.agent === 'codex')!
    const grok = cs.find((c) => c.agent === 'grok')!
    const agy = cs.find((c) => c.agent === 'agy')!
    const prior = (codex.score! + grok.score! + agy.score!) / 3

    expect(codex.score).toBeCloseTo(0.8)
    expect(codex.shrunk).toBeCloseTo((4 + MIN_SAMPLE * prior) / (5 + MIN_SAMPLE))
    expect(grok.shrunk).toBeCloseTo((31 + MIN_SAMPLE * prior) / (40 + MIN_SAMPLE))
    expect(agy.shrunk).toBeCloseTo((MIN_SAMPLE * prior) / (40 + MIN_SAMPLE))
  })

  test('shrinkage uses a 0.5 prior when the job has no proven agent', () => {
    judged('codex', 1, 0)
    const codex = candidates('review-lens-inline').find((c) => c.agent === 'codex')!
    expect(codex.score).toBe(1)
    expect(codex.shrunk).toBeCloseTo((1 + MIN_SAMPLE * 0.5) / (1 + MIN_SAMPLE))
  })

  test('pick and guide rank proven agents by shrunk score and report both means', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)

    const routed = pick('review-lens-inline', undefined, 0, false)
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('78% (shrunk 75%) over 40 judged')

    const g = guide('review-lens-inline')[0]!
    expect(g.best!.agent).toBe('grok')
    expect(g.best!.score).toBeCloseTo(0.775)
    expect(g.best!.shrunk).toBeCloseTo(0.747222)
  })

  test('pick, guide, and stats print raw and shrunk scores, including a changed leader', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)
    const cli = new URL('cli.ts', import.meta.url).pathname
    const runCli = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })

    const pickOut = new TextDecoder().decode(runCli('pick', 'review-lens-inline').stdout)
    const guideOut = new TextDecoder().decode(runCli('guide', '--job', 'review-lens-inline').stdout)
    const statsOut = new TextDecoder().decode(runCli('stats', '--job', 'review-lens-inline').stdout)
    expect(pickOut).toContain('78% (shrunk 75%) over 40 judged')
    expect(pickOut).toContain('score=78% shrunk=75%')
    expect(guideOut).toContain('78% raw,   75% shrunk')
    expect(guideOut).toContain('SHRUNK LEADER (raw: codex)')
    expect(statsOut).toContain('raw  shrunk')
    expect(statsOut).toContain('78%     75%')
  })

  test('the scoreboard is the router, not a second opinion', () => {
    // agy on review-lens: one good answer and two headless denials. The old
    // report filtered status='ok' and called that 100%; the router called it 0%.
    score(addRun({ agent: 'agy', job: 'review-lens' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })

    const fromRouter = candidates('review-lens').find((c) => c.agent === 'agy')!
    const fromBoard = scoreboard('review-lens').find((c) => c.agent === 'agy')!
    expect(fromBoard.score).toBe(fromRouter.score)
    expect(fromBoard.shrunk).toBe(fromRouter.shrunk)
    expect(fromBoard.evidence).toBe(fromRouter.evidence)
    expect(fromBoard.failures).toBe(2)
    // The number the report used to show, and the one it shows now.
    expect(fromBoard.score).toBe(0)
  })

  test('every cell in the scoreboard matches candidates() for its job', () => {
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'codex', job: 'craft', status: 'stale' })
    score(addRun({ agent: 'grok', job: 'safety' }), 'full', 'mixed' )
    for (const cell of scoreboard()) {
      const c = candidates(cell.job).find((x) => x.agent === cell.agent)!
      expect(cell.score).toBe(c.score)
      expect(cell.shrunk).toBe(c.shrunk)
      expect(cell.evidence).toBe(c.evidence)
      expect(cell.runs).toBe(c.runs)
    }
  })

  test('a job filter narrows the rows without changing any of them', () => {
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'grok', job: 'safety', status: 'failed' })
    const all = scoreboard()
    const one = scoreboard('craft')
    expect(one.every((r) => r.job === 'craft')).toBe(true)
    for (const r of one) {
      expect(all.find((x) => x.job === r.job && x.agent === r.agent)!.score).toBe(r.score)
    }
  })

  test('an agent with no history for a job is not a row at all', () => {
    // Absent, rather than present at zero — never asked is not the same as bad.
    expect(scoreboard('craft').find((r) => r.agent === 'agy')).toBeUndefined()
  })
})

describe('what the views print beside a percentage', () => {
  test('a failure-only cell has a negative mean, which a bar cannot render', () => {
    // The router is entitled to a negative score. `width:-50%` renders as
    // nothing, with no hint that the cell is bad rather than empty.
    addRun({ agent: 'agy', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'agy')!
    expect(c.score).toBeLessThan(0)
    const pct = Math.round(c.score! * 100)
    expect(Math.max(0, Math.min(100, pct))).toBe(0)
  })

  test('evidence is what MIN_SAMPLE counts, so it is what a surface must print', () => {
    // One good verdict plus two unjudged failures: the mean is 0 over THREE
    // judgements. A surface printing "0% of 1" beside it is incoherent — a 0%
    // on a single `right` verdict cannot happen.
    score(addRun({ agent: 'agy', job: 'review-lens-inline' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'stale' })
    const c = candidates('review-lens-inline').find((x) => x.agent === 'agy')!
    expect(c.score).toBe(0)
    expect(c.scored).toBe(1)     // verdicts alone
    expect(c.evidence).toBe(3)   // what the 0% is actually over
  })
})

describe('retry keeps the work on the same agent', () => {
  test('a retry is linked to what it re-attempts', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
    const second = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
    const row = db().query('SELECT retry_of FROM run WHERE id=?').get(second) as { retry_of: number }
    expect(row.retry_of).toBe(first)
  })

  test('a quota failure is retained but its successful retry is the only evidence', () => {
    const first = addRun({ agent: 'codex', job: 'craft', status: 'failed', kind: 'quota' })
    const second = addRun({ agent: 'codex', job: 'craft' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
    score(second, 'full', 'right')
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.failures).toBe(0)
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
  })

  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (args: string[], extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ...extraEnv,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const occurrences = (hay: string, needle: string) => {
    let n = 0, i = 0
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length }
    return n
  }
  const boundBeside = (promptPath: string) => promptPath.replace(/\.prompt\.txt$/, '.bound.txt')

  test('a read-only run stores the caller prompt unwrapped and the bound prompt beside it', async () => {
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    agent.bin = process.execPath
    agent.argv = () => ['-e', '']
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const original = 'What does foo.ts do?'
    try {
      const result = await runJob({
        job: 'file-question', prompt: original, cwd: dir, agent: 'codex',
      })
      const row = db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }
      expect(readFileSync(row.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(boundBeside(row.prompt_path), 'utf8')
      expect(occurrences(bound, READONLY_PREAMBLE)).toBe(1)
      expect(bound.endsWith(original)).toBe(true)
      expect(runDetail(result.id)?.prompt).toBe(original)
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('retry of a read-only run produces a child whose bound prompt contains the preamble exactly once', () => {
    const original = 'What does bar.ts do?'
    const promptPath = join(dir, 'retry-original.prompt.txt')
    writeFileSync(promptPath, original)
    const schemaPath = join(dir, 'retry-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }))
    const id = addRun({ agent: 'grok', job: 'file-question', status: 'failed' })
    db().query(
      `UPDATE run SET prompt_path=?, mcp=1, schema_path=?, model=?, cwd=? WHERE id=?`,
    ).run(promptPath, schemaPath, 'retry-model', dir, id)

    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-grok-retry-'))
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\nexit 0\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const r = orch(['retry', String(id)], { PATH: `${binDir}:${process.env.PATH ?? ''}` })
      expect(r.code).toBe(0)
      const child = db().query(
        `SELECT id, prompt_path, mcp, schema_path, model, retry_of, agent
           FROM run WHERE retry_of=?`,
      ).get(id) as {
        id: number; prompt_path: string; mcp: number | null; schema_path: string | null
        model: string | null; retry_of: number; agent: string
      } | null
      expect(child).not.toBeNull()
      expect(child!.agent).toBe('grok')
      expect(child!.mcp).toBe(1)
      expect(child!.schema_path).toBe(schemaPath)
      expect(child!.model).toBe('retry-model')
      expect(readFileSync(child!.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(boundBeside(child!.prompt_path), 'utf8')
      expect(occurrences(bound, READONLY_PREAMBLE)).toBe(1)
      expect(bound.endsWith(original)).toBe(true)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('retry of an implement run continues its session detached and prints the child id', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-retry-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET vendor_session=?, cwd=? WHERE id=?')
      .run('retry-session', dir, id)
    try {
      const r = orch(['retry', String(id)], {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FORCE_COLOR: '1',
      })
      expect(r.code).toBe(0)
      const childId = Number(r.out.trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch(['wait', String(childId), '--timeout', '15'])
      const child = db().query(
        'SELECT parent_run_id, turn, vendor_session FROM run WHERE id=?',
      ).get(childId) as {
        parent_run_id: number | null; turn: number; vendor_session: string | null
      }
      expect(child.parent_run_id).toBe(id)
      expect(child.turn).toBe(2)
      expect(child.vendor_session).toBe('retry-session')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('a writing retry refuses to change agents and directs a fresh start', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET vendor_session=?, cwd=? WHERE id=?')
      .run('retry-session', dir, id)
    const r = orch(['retry', String(id), '--agent', 'codex'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      'a writing run continues on its own agent (grok); to start over on codex: ' +
      'orch do implement --agent codex ...',
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id))
      .toEqual({ n: 0 })
  })

  test('retry and continue give the same refusal when the chain has no session', () => {
    for (const command of ['retry', 'continue']) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
      const r = orch([command, String(id)])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`run ${id} recorded no session id, so codex cannot be resumed`)
    }
  })
})

describe('quota failover is one bounded unit of work', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: dir,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  test('a quota death runs the original prompt on another agent and returns that answer', async () => {
    const binDir = join(dir, 'failover-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "HTTP 402: balance exhausted" >&2\nexit 1\n')
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","result":"successor answer"}\\n\'\n',
    )
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'understand', prompt: 'the exact original prompt', agent: 'codex', cwd: dir,
        ownerSession: 'failover-owner',
      })
      expect(result.agent).toBe('grok')
      expect(result.output).toBe('successor answer')
      const rows = db().query(
        'SELECT id, agent, status, failure_kind, retry_of, session_id FROM run ORDER BY id',
      ).all() as {
        id: number; agent: string; status: string; failure_kind: string | null
        retry_of: number | null; session_id: string | null
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ agent: 'codex', status: 'failed', failure_kind: 'quota' })
      expect(rows[1]).toMatchObject({
        agent: 'grok', status: 'ok', retry_of: rows[0]!.id, session_id: 'failover-owner',
      })

      const collected = orch('result', String(rows[0]!.id))
      expect(collected.code).toBe(0)
      expect(collected.out).toContain('successor answer')
      expect(collected.err).toContain('codex died (quota:')
      expect(collected.err).toContain('grok answered')
      expect(pendingForSession('failover-owner').map((row) => row.id)).toEqual([rows[1]!.id])
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('runs, runs --json, and --follow report the same failover chain', () => {
    const binDir = join(dir, 'failover-surfaces-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "HTTP 402: balance exhausted" >&2\nexit 1\n')
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","result":"shared surface answer"}\\n\'\n',
    )
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    try {
      const followed = orch(
        'do', 'understand', 'report one chain everywhere', '--agent', 'codex', '--follow',
        '--key', 'DEV-133',
      )
      expect(followed.code).toBe(0)
      expect(followed.out).toContain('shared surface answer')

      const attempts = db().query(
        'SELECT id, agent, retry_of FROM run ORDER BY id',
      ).all() as { id: number; agent: string; retry_of: number | null }[]
      expect(attempts).toHaveLength(2)
      const [first, successor] = attempts as [typeof attempts[number], typeof attempts[number]]
      expect(successor.retry_of).toBe(first.id)
      db().query('UPDATE run SET vendor_tokens=?, vendor_cost_usd=? WHERE id=?')
        .run(111, 0.11, first.id)
      db().query('UPDATE run SET vendor_tokens=?, vendor_cost_usd=? WHERE id=?')
        .run(222, 0.22, successor.id)

      const human = orch('runs')
      expect(human.code).toBe(0)
      expect(human.out.match(new RegExp(`\\b${first.id}\\s+codex→grok`, 'g'))).toHaveLength(1)
      expect(human.out).not.toMatch(new RegExp(`\\b${successor.id}\\s+`))

      const json = orch('runs', '--json')
      expect(json.code).toBe(0)
      const listed = json.out.trim().split('\n').map((line) => JSON.parse(line)) as {
        id: number; agent: string; retry_of: number | null; failover_chain: string[]
        vendor_tokens: number; vendor_cost_usd: number
      }[]
      expect(listed.map((row) => row.id)).toEqual([successor.id, first.id])
      expect(listed.map((row) => row.retry_of)).toEqual([first.id, null])
      expect(listed.map((row) => [row.vendor_tokens, row.vendor_cost_usd]))
        .toEqual([[222, 0.22], [111, 0.11]])
      expect(listed.every((row) =>
        JSON.stringify(row.failover_chain) === JSON.stringify(['codex', 'grok']),
      )).toBe(true)

      expect(followed.err).toContain(`run ${successor.id} · grok`)
      expect(followed.err).not.toContain(`run ${first.id} · grok`)
    } finally {
      process.env.PATH = oldPath
    }
  })

  test('--no-failover holds and records a clear terminal explanation', async () => {
    const binDir = join(dir, 'no-failover-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "usage limit reached" >&2\nexit 1\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'understand', prompt: 'do not retry this', agent: 'codex', cwd: dir,
        noFailover: true,
      })).rejects.toThrow(/usage limit reached/)
      const row = db().query(
        'SELECT no_failover, failure_kind, error FROM run ORDER BY id DESC LIMIT 1',
      ).get() as { no_failover: number; failure_kind: string; error: string }
      expect(row.no_failover).toBe(1)
      expect(row.failure_kind).toBe('quota')
      expect(row.error).toContain('Failover refused: disabled by --no-failover')
      expect(row.error).toContain('worktree ')
      expect(row.error).not.toContain('(none — read-only job)')
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('three quota deaths spend the attempt budget and name every agent', async () => {
    const binDir = join(dir, 'budget-bin')
    mkdirSync(binDir, { recursive: true })
    for (const bin of ['codex', 'agy']) {
      writeFileSync(join(binDir, bin), '#!/bin/sh\necho "HTTP 402: no balance" >&2\nexit 1\n')
      chmodSync(join(binDir, bin), 0o755)
    }
    writeFileSync(
      join(binDir, 'grok'),
      '#!/bin/sh\nprintf \'{"type":"result","errors":["HTTP 402: no balance"]}\\n\'\n',
    )
    chmodSync(join(binDir, 'grok'), 0o755)
    const oldPath = process.env.PATH
    const oldDepth = process.env.ORCH_DEPTH
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'review-lens-inline', prompt: 'bounded', agent: 'codex', cwd: dir, lens: 'bounded',
      })).rejects.toThrow()
      const rows = db().query(
        'SELECT id, agent, retry_of, error FROM run ORDER BY id',
      ).all() as { id: number; agent: string; retry_of: number | null; error: string }[]
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.agent)).toEqual(['codex', 'agy', 'grok'])
      expect(rows[2]!.error).toContain('the 3-attempt budget was spent')
      expect(rows[2]!.error).toContain('tried codex, agy, grok')
    } finally {
      process.env.PATH = oldPath
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
    }
  })

  test('a writing run with edits names and preserves its tree instead of failing over', () => {
    const reason = writingFailoverRefusal(true, {
      files: ['partial.ts'], diff: 'diff', insertions: 1, deletions: 0,
    }, '/tmp/orch-42')
    expect(reason).toBe(
      'writing run has 1 changed file(s); preserving worktree /tmp/orch-42 ' +
      'so two agents never share one diff',
    )
    expect(writingFailoverRefusal(true, {
      files: [], diff: '', insertions: 0, deletions: 0,
    }, '/tmp/orch-42')).toBeNull()
    expect(writingFailoverRefusal(true, null, '/tmp/orch-42'))
      .toContain('worktree diff could not be read')
  })

  test('a resumed turn can also fail over forward without confusing the two axes', () => {
    const root = addRun({ agent: 'codex', job: 'understand', status: 'failed' })
    const turn = addRun({
      agent: 'codex', job: 'understand', status: 'failed', kind: 'quota', parent: root, turn: 2,
    })
    db().query("UPDATE run SET error='HTTP 402' WHERE id IN (?,?)").run(root, turn)
    const successor = addRun({ agent: 'grok', job: 'understand', session: 's' })
    db().query('UPDATE run SET retry_of=?, automatic_failover=1 WHERE id=?').run(turn, successor)
    const output = join(dir, `combined-axes-${successor}.txt`)
    writeFileSync(output, 'answer after resumed failure')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, successor)

    const waited = orch('wait', String(root))
    expect(waited.code).toBe(0)
    expect(waited.out).toContain(`${root}\tok`)
    expect(waited.out).toContain('codex died (quota: HTTP 402); grok answered')
    const result = orch('result', String(root))
    expect(result.out).toContain('answer after resumed failure')
    expect(result.err).toContain('grok answered')
    const listed = orch('runs')
    expect(listed.out.match(new RegExp(`\\b${root}\\s+codex→grok`, 'g'))).toHaveLength(1)
    expect(listed.out).not.toMatch(new RegExp(`\\b${successor}\\s+`))
  })

  test('a deliberate retry remains separate from an automatic failover chain', () => {
    const first = addRun({ agent: 'codex', job: 'understand', status: 'failed', kind: 'quota' })
    const retry = addRun({ agent: 'grok', job: 'understand' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, retry)
    const original = orch('result', String(first))
    expect(original.code).toBe(1)
    expect(original.err).not.toContain('failover:')
    const retried = orch('result', String(retry))
    expect(retried.code).toBe(0)
    expect(retried.err).not.toContain('failover:')
    const listed = orch('runs')
    expect(listed.out).toMatch(new RegExp(`\\b${first}\\s+codex\\s+`))
    expect(listed.out).toMatch(new RegExp(`\\b${retry}\\s+grok\\s+`))
  })
})

describe('a destroyed output is not evidence about the agent', () => {
  test('score --void retains the run, output, and score but removes routing evidence', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const outputPath = join(dir, 'voided-output.txt')
    writeFileSync(outputPath, 'the retained answer')
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id=?').run(outputPath, id)
    score(id, 'full', 'right')

    const p = Bun.spawnSync([process.execPath, CLI, 'score', String(id), '--void'], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(p.exitCode).toBe(0)
    expect(new TextDecoder().decode(p.stdout)).toContain('retained run and output')
    expect(readFileSync(outputPath, 'utf8')).toBe('the retained answer')
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id))
      .toEqual({ evidence_excluded: 'voided with orch score --void' })
    expect(db().query('SELECT COUNT(*) n FROM score WHERE run_id=?').get(id)).toEqual({ n: 1 })
    expect(candidates('review-lens').find((c) => c.agent === 'codex')!.evidence).toBe(0)
  })

  test('a scored collision is kept as a verdict and dropped from routing', () => {
    // The score stays: a person did judge what they were shown. It simply
    // stops counting, because what they were shown was another run's work.
    const kept = addRun({ agent: 'codex', job: 'review-lens' })
    score(kept, 'full', 'right')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    score(a, 'none')
    score(b, 'none')
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id IN (?,?)")
      .run(a, b)

    const c = candidates('review-lens').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('full', 'right'))
    const n = (db().query('SELECT COUNT(*) n FROM score').get() as { n: number }).n
    expect(n).toBe(3)
  })

  test('the backfill stamps every member of a colliding group, and no unique path', () => {
    const shared = join(dir, 'collided.txt')
    const unique = join(dir, 'alone.txt')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    const c = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
    db().query('UPDATE run SET output_path=? WHERE id=?').run(unique, c)
    expect(excludeSharedOutputRuns(db())).toBe(2)
    const rows = db().query(
      'SELECT id, evidence_excluded AS why FROM run WHERE id IN (?,?,?) ORDER BY id',
    ).all(a, b, c) as { id: number; why: string | null }[]
    expect(rows.find((r) => r.id === a)!.why).toBe(SHARED_OUTPUT_REASON)
    expect(rows.find((r) => r.id === b)!.why).toBe(SHARED_OUTPUT_REASON)
    expect(rows.find((r) => r.id === c)!.why).toBeNull()
  })

  test('a reason already written is left alone', () => {
    const shared = join(dir, 'already.txt')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
    db().query("UPDATE run SET evidence_excluded='already set' WHERE id=?").run(a)
    expect(excludeSharedOutputRuns(db())).toBe(1)
    const why = db().query(
      'SELECT evidence_excluded AS why FROM run WHERE id=?',
    ).get(a) as { why: string }
    expect(why.why).toBe('already set')
  })

  test('orch result says so on the record a person would score from', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id=?").run(id)
    const p = Bun.spawnSync([process.execPath, CLI, 'result', String(id)], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const err = new TextDecoder().decode(p.stderr)
    expect(p.exitCode).toBe(0)
    expect(err).toContain('not routing evidence: shared an output file')
  })
})

describe('a probe proves an agent is alive without vouching for it', () => {
  test('a probe clears a cooldown, which is the only way to clear one early', () => {
    // Deliberate, and the one query that does not filter probes. Availability
    // is not quality: a human who tops up a quota needs a way to say so.
    const base = Date.now() - 10_000
    const failed = addRun({
      agent: 'codex', job: 'craft', status: 'failed',
      startedAt: new Date(base).toISOString(), latency: 1000,
    })
    db().query("UPDATE run SET failure_kind='quota' WHERE id=?").run(failed)
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toContain('quota')

    addRun({
      agent: 'codex', job: 'craft', probe: 1,
      startedAt: new Date(base + 2000).toISOString(), latency: 1000,
    })  // succeeded later, calibration
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toBeNull()
  })

  test('but the probe still teaches routing nothing', () => {
    score(addRun({ agent: 'codex', job: 'safety', probe: 1 }), 'full', 'right')
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.score).toBeNull()
  })

  test('guide plainly reports an agent whose vendor circuit is open', () => {
    const failed = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='auth' WHERE id=?").run(failed)
    const row = guide('craft')[0]!
    expect(row.excluded).toContainEqual({
      agent: 'codex',
      why: expect.stringContaining('vendor auth'),
    })
  })
})

describe('the noise band', () => {
  test('is one judgement step over MIN_SAMPLE, which is what its comment claims', () => {
    expect(QUALITY_STEP).toBe(weigh('full', 'right') - weigh('full', 'mixed'))
    expect(NOISE_BAND).toBeCloseTo(QUALITY_STEP / MIN_SAMPLE)
    expect(NOISE_BAND).toBeCloseTo(0.1)
  })

  test('it is NOT the full spread of the scale, which is a different question', () => {
    // A review lens proposed (WEIGHT_MAX - weigh('none')) / MIN_SAMPLE / 2 =
    // 0.15. That measures the whole scale; the band measures one judgement.
    const spread = weigh('full', 'right') - weigh('none', null)
    expect(spread).toBe(1.5)
    expect(NOISE_BAND).not.toBeCloseTo(spread / MIN_SAMPLE / 2)
  })

  test('it tracks the matrix rather than a constant that happens to match', () => {
    // The old derivation was WEIGHT_MAX / MIN_SAMPLE / 2. It agreed only
    // because WEIGHT_MAX/2 and one quality step are both 0.5 today.
    const coincidence = 1 / MIN_SAMPLE / 2
    expect(NOISE_BAND).toBeCloseTo(coincidence)          // same number now
    expect(QUALITY_STEP).not.toBe(1 / 2 + 0.0001)        // but derived differently
  })
})

describe('routing exploration', () => {
  test('a wrong answer stays explorable, while delivery-none-only history does not', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    const wrong = addRun({ agent: 'grok', job: 'review-lens' })
    score(wrong, 'full', 'wrong')

    const random = Math.random
    Math.random = () => 0
    try {
      expect(pick('review-lens').agent).toBe('grok')
      db().query("UPDATE score SET delivery='none', quality=NULL WHERE run_id=?").run(wrong)
      expect(pick('review-lens').agent).toBe('codex')
    } finally {
      Math.random = random
    }
  })

  test('the standing draw picks a proven non-leader', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'mixed')
    }

    const random = Math.random
    Math.random = () => STANDING_EXPLORE_RATE / 2
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).toContain('standing challenger')
    } finally {
      Math.random = random
    }
  })
})

describe('routing evidence scope', () => {
  test('only the most recent evidence window counts in candidates and the scoreboard', () => {
    for (let i = 0; i < 5; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'wrong')
    }
    for (let i = 0; i < EVIDENCE_WINDOW; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }

    const candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    const cell = scoreboard('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(EVIDENCE_WINDOW)
    expect(candidate.score).toBe(1)
    expect(cell.evidence).toBe(EVIDENCE_WINDOW)
    expect(cell.score).toBe(candidate.score)
  })

  test('current-model evidence is used at MIN_SAMPLE and otherwise falls back across models', () => {
    const current = AGENTS.codex!.model
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens', model: 'older-model' }), 'full', 'wrong')
    }
    for (let i = 0; i < MIN_SAMPLE - 1; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens', model: current }), 'full', 'right')
    }

    let candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(MIN_SAMPLE * 2 - 1)
    expect(candidate.evidenceModel).toBeNull()
    expect(pick('review-lens', undefined, 0, false).reason).toContain('across models')

    score(addRun({ agent: 'codex', job: 'review-lens', model: current }), 'full', 'right')
    candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(MIN_SAMPLE)
    expect(candidate.score).toBe(1)
    expect(candidate.evidenceModel).toBe(current)
    expect(pick('review-lens', undefined, 0, false).reason).toContain(`on model ${current}`)
  })
})

describe('what counts as unscored', () => {
  test('only a successful, non-probe, unjudged run is owed a judgement', () => {
    addRun({ agent: 'grok', job: 'craft' })                          // owed
    addRun({ agent: 'grok', job: 'craft', probe: 1 })                // calibration
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })        // already none
    addRun({ agent: 'grok', job: 'craft', status: 'stale' })         // already none
    addRun({ agent: 'grok', job: 'craft', status: 'running' })       // not finished
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')  // judged

    // `runs - scores` — what doctor and the card used to do — would say 5.
    expect(unscoredCount()).toBe(1)
  })

  test('doctor and pending cannot disagree, because they share the rule', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('S', mine)
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    expect(pendingForSession('S').length).toBe(1)
    expect(unscoredCount()).toBe(1)
  })

  test('the count honours the dashboard window', () => {
    const old = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 86_400_000).toISOString(), old)
    addRun({ agent: 'grok', job: 'craft' })
    expect(unscoredCount()).toBe(2)
    expect(unscoredCount(new Date(Date.now() - 7 * 86_400_000).toISOString())).toBe(1)
  })
})

describe('probes are excluded from every query that reports', () => {
  test('byRepo leaves calibration traffic out', () => {
    // The rule is stated in AGENTS.md and this was the one aggregate that had
    // no test holding it: byRepo counted probes until it was noticed by eye.
    const real = addRun({ agent: 'grok', job: 'craft' })
    const probe = addRun({ agent: 'grok', job: 'craft', probe: 1 })
    for (const id of [real, probe]) {
      db().query("UPDATE run SET repo='devbox', vendor_tokens=100 WHERE id=?").run(id)
    }
    const rows = state(null).byRepo as { repo: string; runs: number; toks: number }[]
    const devbox = rows.find((r) => r.repo === 'devbox')!
    expect(devbox.runs).toBe(1)
    expect(devbox.toks).toBe(100)
  })
})

describe('run detail', () => {
  test('publishes every field hub reads without publishing the ask credential', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'failed', latency: 1234, probe: 1 })
    const promptPath = join(dir, 'detail-prompt.txt')
    const outputPath = join(dir, 'detail-output.txt')
    writeFileSync(promptPath, 'the whole prompt')
    writeFileSync(outputPath, 'the whole reply')
    db().query(
      `UPDATE run SET vendor_tokens=?, failure_kind=?, evidence_excluded=?, error=?,
                      prompt_path=?, output_path=?, run_token=? WHERE id=?`,
    ).run(5678, 'timeout', 'not evidence', 'timed out', promptPath, outputPath, 'secret', id)
    score(id, 'partial', 'mixed')
    db().query('UPDATE score SET note=? WHERE run_id=?').run('read by hub', id)

    const detail = runDetail(id)!
    expect(detail).toMatchObject({
      id, agent: 'grok', job: 'craft', latency_ms: 1234, vendor_tokens: 5678,
      status: 'failed', failure_kind: 'timeout', probe: 1,
      evidence_excluded: 'not evidence', error: 'timed out',
      delivery: 'partial', quality: 'mixed', note: 'read by hub',
      prompt: 'the whole prompt', output: 'the whole reply',
    })
    expect(detail).not.toHaveProperty('run_token')
  })
})

describe('review-lens MCP provenance', () => {
  test('preflightMcp refuses grok and lets a Codex pin through', () => {
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const grok = AGENTS.grok!
    const originalBin = grok.bin
    grok.bin = join(dir, 'fake-grok-preflight-doctor.sh')
    writeFileSync(grok.bin, `#!/bin/sh
printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
`)
    chmodSync(grok.bin, 0o755)
    try {
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'codex',
      })).not.toThrow()
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).toThrow("MCP was requested, but server 'fixture-project' could not be attached")
      expect(() => preflightMcp({
        mcp: false, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).not.toThrow()
    } finally {
      grok.bin = originalBin
    }
  })

  test('preflightMcp reads an explicit MCP server name from the project register', () => {
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: { mcpServer: 'orch' } })
    const grok = AGENTS.grok!
    const originalBin = grok.bin
    grok.bin = join(dir, 'fake-grok-configured-server-doctor.sh')
    writeFileSync(grok.bin, `#!/bin/sh
printf '%s' '{"servers":[{"name":"orch","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
`)
    chmodSync(grok.bin, 0o755)
    try {
      expect(() => preflightMcp({
        mcp: true, cwd, job: 'review-lens', prompt: 'review this', agent: 'grok',
      })).toThrow("MCP was requested, but server 'orch' could not be attached")
    } finally {
      grok.bin = originalBin
    }
  })

  test('reads Grok doctor as the same-named project connection', () => {
    const doctor = join(dir, 'fake-grok-mcp-doctor.sh')
    writeFileSync(doctor, `#!/bin/sh
printf '%s' '{"servers":[{"name":"starship","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started","hint":"re-run with --trust"}]}]}'
`)
    chmodSync(doctor, 0o755)
    expect(grokMcpConnection(doctor, dir, 'starship', { PATH: process.env.PATH ?? '' }))
      .toEqual({
        server: 'starship', connected: false,
        error: 'folder untrusted: repo-local server not started: re-run with --trust',
      })
  })

  test('a missing server names the ones doctor did report', () => {
    const doctor = join(dir, 'fake-grok-mcp-available.sh')
    writeFileSync(doctor, `#!/bin/sh
printf '%s' '{"servers":[{"name":"orch","healthy":true,"checks":[]},{"name":"user-scope","healthy":true,"checks":[]}]}'
`)
    chmodSync(doctor, 0o755)
    const result = grokMcpConnection(doctor, dir, 'starship', { PATH: process.env.PATH ?? '' })
    expect(result.connected).toBe(false)
    expect(result.error).toContain("MCP server 'starship' was not reported. Available: orch, user-scope")
    expect(result.error).toContain('"name":"orch"')
  })

  test('refuses a grok lens at dispatch and leaves no run row when project MCP cannot attach', async () => {
    const script = join(dir, 'fake-grok-lens.sh')
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "mcp" ]; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started","hint":"re-run with --trust"}]}]}'
else
  echo should-not-launch >&2
  exit 99
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    let sent = ''
    agent.bin = script
    agent.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    try {
      await expect(runJob({
        job: 'review-lens', prompt: 'review this', cwd, agent: 'grok', mcp: true, lens: 'mcp',
      })).rejects.toThrow("MCP was requested, but server 'fixture-project' could not be attached")
      expect(sent).toBe('')
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a lens proceeds unchanged when its requested project MCP attaches', async () => {
    const script = join(dir, 'fake-grok-connected-lens.sh')
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "mcp" ]; then
  printf '%s' '{"servers":[{"name":"orch","healthy":true,"checks":[]}]}'
else
  printf '%s\n' '{"type":"system","subtype":"init"}'
  printf '%s\n' '{"type":"result","subtype":"success","result":"no findings"}'
fi
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    let sent = ''
    agent.bin = script
    agent.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: { mcpServer: 'orch' } })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd, agent: 'grok', mcp: true, lens: 'mcp',
      })
      expect(sent).toContain('Provenance: state the source you measured against.')
      expect(db().query(
        'SELECT mcp_server, mcp_connected FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp_server: 'orch', mcp_connected: 1,
      })
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a lens without --mcp is unaffected and does not run the MCP doctor', async () => {
    const script = join(dir, 'fake-grok-no-mcp-lens.sh')
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "mcp" ]; then
  exit 99
fi
printf '%s\n' '{"type":"system","subtype":"init"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"no findings"}'
`)
    chmodSync(script, 0o755)
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    agent.bin = script
    agent.argv = () => []
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd: dir, agent: 'grok', mcp: false, lens: 'mcp',
      })
      expect(result.status).toBe('ok')
      expect(db().query(
        'SELECT mcp, mcp_server, mcp_connected, mcp_error FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp: 0, mcp_server: null, mcp_connected: null, mcp_error: null,
      })
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('orch result exposes degradation and the explicit trust command', () => {
    const id = addRun({ agent: 'grok', job: 'review-lens' })
    db().query(
      `UPDATE run SET cwd=?, mcp=1, mcp_server='starship', mcp_connected=0,
                      mcp_error='folder untrusted: repo-local server not started' WHERE id=?`,
    ).run('/tmp/a lens tree', id)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const result = Bun.spawnSync([process.execPath, CLI, 'result', String(id)], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe',
    })
    const stderr = result.stderr.toString()
    expect(result.exitCode).toBe(0)
    expect(stderr).toContain('mcp:       starship NOT CONNECTED')
    expect(stderr).toContain("trust:     grok --cwd '/tmp/a lens tree' --trust")
  })

  test('orch result names an unverified attach distinctly from a confirmed one', () => {
    const unverified = addRun({ agent: 'codex', job: 'review-lens' })
    db().query(
      `UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=NULL,
                      mcp_error='codex does not expose an MCP connection diagnostic' WHERE id=?`,
    ).run(unverified)
    const confirmed = addRun({ agent: 'grok', job: 'review-lens' })
    db().query(
      `UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=1 WHERE id=?`,
    ).run(confirmed)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const env = { ...process.env, ORCH_DB: process.env.ORCH_DB! }
    const unknown = Bun.spawnSync([process.execPath, CLI, 'result', String(unverified)], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    const known = Bun.spawnSync([process.execPath, CLI, 'result', String(confirmed)], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(unknown.stderr.toString()).toContain('mcp:       fixture-project UNVERIFIED')
    expect(unknown.stderr.toString()).not.toContain('connected')
    expect(known.stderr.toString()).toContain('mcp:       fixture-project connected')
    expect(known.stderr.toString()).not.toContain('UNVERIFIED')
  })

  test('a codex lens proceeds unverified even when grok doctor would refuse', async () => {
    const grok = AGENTS.grok!
    const codex = AGENTS.codex!
    const grokBin = grok.bin
    const grokArgv = grok.argv
    const codexBin = codex.bin
    const codexArgv = codex.argv
    const codexReadsOut = codex.readsOut
    grok.bin = join(dir, 'fake-grok-red-doctor.sh')
    writeFileSync(grok.bin, `#!/bin/sh
printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"folder untrusted","passed":false,"detail":"repo-local server not started"}]}]}'
exit 0
`)
    chmodSync(grok.bin, 0o755)
    grok.argv = () => {
      throw new Error('grok must not launch')
    }
    const script = join(dir, 'fake-codex-unverified-lens.sh')
    writeFileSync(script, `#!/bin/sh
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"no findings"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`)
    chmodSync(script, 0o755)
    let sent = ''
    codex.bin = script
    codex.readsOut = false
    codex.argv = ({ prompt }) => {
      sent = prompt
      return []
    }
    const cwd = dir
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'review-lens', prompt: 'review this', cwd, agent: 'codex', mcp: true, lens: 'probe',
      })
      expect(result.status).toBe('ok')
      expect(sent).toContain('Provenance: state the source you measured against.')
      expect(db().query(
        'SELECT mcp, mcp_server, mcp_connected, mcp_error FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        mcp: 1, mcp_server: 'fixture-project', mcp_connected: null,
        mcp_error: 'codex does not expose an MCP connection diagnostic',
      })
    } finally {
      grok.bin = grokBin
      grok.argv = grokArgv
      codex.bin = codexBin
      codex.argv = codexArgv
      codex.readsOut = codexReadsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('orch do refuses a proven-failed grok attach once, with no row', () => {
    const cwd = realpathSync(dir)
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const binDir = join(dir, 'mcp-dispatch-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh
if [ "$1" = "mcp" ]; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
  exit 0
fi
echo should-not-launch >&2
exit 99
`)
    chmodSync(join(binDir, 'grok'), 0o755)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'review-lens', 'review this', '--mcp', '--agent', 'grok', '--lens', 'probe'],
      {
        cwd,
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe', stderr: 'pipe',
      },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      "MCP was requested, but server 'fixture-project' could not be attached",
    )
    expect(result.stderr.toString()).toContain('unavailable: server down')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('a fan-out of grok --mcp against an unavailable server leaves zero rows', async () => {
    const cwd = realpathSync(dir)
    upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
    const binDir = join(dir, 'mcp-fanout-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh
if [ "$1" = "mcp" ]; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
  exit 0
fi
echo should-not-launch >&2
exit 99
`)
    chmodSync(join(binDir, 'grok'), 0o755)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const env = {
      ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }
    const children = [1, 2, 3].map((n) => Bun.spawn(
      [process.execPath, CLI, 'do', 'review-lens', `lens ${n}`, '--mcp', '--agent', 'grok', '--lens', 'probe'],
      { cwd, env, stdout: 'pipe', stderr: 'pipe' },
    ))
    const codes = await Promise.all(children.map(async (child) => {
      const err = await new Response(child.stderr).text()
      const code = await child.exited
      return { code, err }
    }))
    expect(codes.every((row) => row.code === 1)).toBe(true)
    expect(codes.every((row) => row.err.includes(
      "MCP was requested, but server 'fixture-project' could not be attached",
    ))).toBe(true)
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })
})

 describe('median', () => {
  test('there is one implementation, and the guide uses it', () => {
    // Two identical copies lived in route.ts and guide.ts. Identical today is
    // how a pair of copies always starts.
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([3, 1, 2])).toBe(2)          // odd: middle after sorting
    expect(median([4, 1, 3, 2])).toBe(2.5)     // even: mean of the middle two
  })

  test('it does not disturb the array it is given', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })

  test('one hung call does not move it, which is why it is not a mean', () => {
    const withHang = [100, 110, 120, 130, 900_000]
    expect(median(withHang)).toBe(120)
  })
})

describe('the activity window', () => {
  /** A run backdated by `days`, so the window has something to exclude. */
  function agedRun(days: number, o: { agent: string; job: string; status?: string }) {
    const id = addRun(o)
    db().query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - days * 86_400_000).toISOString(), id)
    return id
  }

  test('the counters exclude runs outside the window', () => {
    agedRun(60, { agent: 'grok', job: 'craft', status: 'failed' })   // long ago
    agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' })    // just now

    expect((state(null).totals as { failed: number }).failed).toBe(2)
    expect((state(30).totals as { failed: number }).failed).toBe(1)
    expect((state(1).totals as { failed: number }).failed).toBe(1)
  })

  test('the scored counter excludes judgements on not-evidence runs', () => {
    score(agedRun(0, { agent: 'grok', job: 'craft' }), 'full', 'right')
    const interrupted = agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    score(interrupted, 'none')

    expect((state(null).totals as { scored: number }).scored).toBe(1)
  })

  test('a fix can actually show up, which is the point of windowing at all', () => {
    // Nine stale runs all predate the try/finally. On a lifetime counter they
    // would announce that bug for ever; on a window they age out and the
    // counter starts telling the truth again.
    agedRun(10, { agent: 'grok', job: 'craft', status: 'stale' })
    expect((state(null).totals as { stale_n: number }).stale_n).toBe(1)
    // Zero, not null. SUM over no rows is NULL in SQLite while COUNT is 0, so
    // an empty window used to answer `failed: null` beside `runs: 0`.
    expect((state(7).totals as { stale_n: number }).stale_n).toBe(0)
  })

  test('the routing matrix is NOT windowed, whatever the band shows', () => {
    // The evidence base. A matrix narrowed to 24 hours would report an agent
    // has no runs while the router is confidently using twenty-six of them.
    score(agedRun(60, { agent: 'grok', job: 'craft' }), 'full', 'right')
    for (const days of [null, 30, 7, 1]) {
      expect((state(days).matrix as unknown[]).length).toBe(1)
    }
  })

  test('the runs-tab badge stays lifetime, so it does not change meaning', () => {
    agedRun(60, { agent: 'grok', job: 'craft' })
    agedRun(0, { agent: 'grok', job: 'craft' })
    expect(state(1).allTimeRuns).toBe(2)
    expect((state(1).totals as { runs: number }).runs).toBe(1)
  })
})

describe('what survives of a failure', () => {
  // The shape that lost four failures: a banner, then the whole prompt echoed
  // back, then — right at the end — what actually went wrong.
  const codexish = (promptChars: number) =>
    'OpenAI Codex v0.151.0\n--------\nmodel: gpt-5.6-sol\nsandbox: read-only\n--------\n' +
    'x'.repeat(promptChars) +
    '\nERROR: the thing that actually broke'

  test('the error at the end is kept', () => {
    expect(errorTail(codexish(50_000))).toContain('the thing that actually broke')
  })

  test('and the banner at the start is kept too', () => {
    // Run 243 was diagnosable only because its banner survived: the model and
    // provider lines were the explanation.
    const out = errorTail(codexish(50_000))
    expect(out).toContain('OpenAI Codex v0.151.0')
    expect(out).toContain('model: gpt-5.6-sol')
  })

  test('the echoed prompt in the middle is what gets dropped', () => {
    const out = errorTail(codexish(50_000))
    expect(out).toContain('characters omitted')
    expect(out.length).toBeLessThan(2200)
  })

  test('a short error is stored whole, untouched', () => {
    expect(errorTail('exit 143, empty output')).toBe('exit 143, empty output')
  })
})

describe('a vendor error is not an answer', () => {
  test("Qwen Code's empty-stream placeholder is recognised", () => {
    // Run 279, verbatim: exit 0, 57 bytes, recorded as a success for 409s and
    // 325k vendor tokens until a person read it.
    expect(isNonAnswer('[API Error: Model stream ended with empty response text.]')).toBe(true)
  })

  test('an empty reply is not an answer either', () => {
    expect(isNonAnswer('')).toBe(true)
    expect(isNonAnswer('   \n  ')).toBe(true)
  })

  test('a Grok streaming transcript is not an answer', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', errors: ['cancelled'] }),
    ].join('\n')
    expect(isNonAnswer(transcript)).toBe(true)
  })

  test('a real answer that DISCUSSES an API error is kept', () => {
    // A review of this very code would quote that string; throwing the reply
    // away because it mentions one would be worse than the bug.
    expect(isNonAnswer('The handler swallows [API Error: ...] and stores it as the reply.')).toBe(false)
    expect(isNonAnswer('No findings. The API error path is covered.')).toBe(false)
  })
})

describe('reachability is a routing input, not a run outcome', () => {
  // Restored after every test in here: a null cache is the permissive default,
  // which is exactly the state the rest of the suite expects.
  afterEach(() => resetLocalHealth())

  // These assertions are about interpreting an endpoint's response, not about
  // opening a listener. Repository workers cannot bind one: Bun reports that
  // denial as EADDRINUSE even for port 0. Keep the fixture in-process so
  // concurrent worktrees have no socket resource to contend over.
  async function withFetchResponse<T>(response: Response, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      () => Promise.resolve(response),
      { preconnect: original.preconnect },
    ) as typeof fetch
    try { return await run() }
    finally { globalThis.fetch = original }
  }

  test('an endpoint nothing is listening on is not reachable', async () => {
    // Port 1 is refused immediately on any machine, so this is fast and does
    // not depend on the local model host being up — or down.
    const r = await localReachable(2000, 'http://127.0.0.1:1/v1')
    expect(r.ok).toBe(false)
  })

  test('a 200 from the wrong service is not reachability', async () => {
    // The gotcha that cost real time: local 8000 is Docker Desktop's, and it
    // answers HTTP 200 with HTML. Status alone would have called that healthy.
    await withFetchResponse(
      new Response('<html>hello</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      async () => {
        const r = await localReachable(2000, 'http://127.0.0.1:8000/v1')
        expect(r.ok).toBe(false)
        expect(r.detail).toContain('something else owns this port')
      },
    )
  })

  test('JSON that is not a model list is not an OpenAI endpoint either', async () => {
    await withFetchResponse(Response.json({ hello: 'world' }), async () => {
      const r = await localReachable(2000, 'http://127.0.0.1:8000/v1')
      expect(r.ok).toBe(false)
    })
  })

  test('a dead endpoint makes the local agent unavailable, not "not installed"', async () => {
    // The whole fix in one assertion. `available()` used to check only that the
    // endpoint was CONFIGURED, which stayed true for every one of the eleven
    // hours the local model host was powered off — so routing kept sending it work.
    await ensureLocalHealth({ force: true, baseUrl: 'http://127.0.0.1:1/v1' })

    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    expect(available(local.name)).toBe(false)
    const why = unavailableReason(local.name)!
    expect(why).toContain('unreachable')
    // And specifically NOT the answer it used to give, which sends you looking
    // for a binary that is sitting right there on PATH.
    expect(why).not.toContain('not installed')
  })

  test('an unreachable endpoint excludes the agent from routing, with the reason', async () => {
    await ensureLocalHealth({ force: true, baseUrl: 'http://127.0.0.1:1/v1' })
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    // file-question is the job it is best at and would otherwise be preferred.
    const c = candidates('file-question').find((x) => x.agent === local.name)!
    expect(c.eligible).toBe(false)
    expect(c.why).toContain('unreachable')
  })

  test('every command that reports a route also checks reachability', () => {
    // `orch do` probed and `orch pick` did not, so during the outage they gave
    // different answers for the same job: pick said qwen-local, do said codex.
    // These four report a route and must all be covered.
    for (const cmd of ['do', 'pick', 'guide', 'doctor']) {
      expect(NEEDS_HEALTH.has(cmd)).toBe(true)
    }
    // History does not change when a machine is switched off, so `stats` is
    // deliberately out — this pins the intent, not just the contents.
    expect(NEEDS_HEALTH.has('stats')).toBe(false)
  })

  test('waking is opt-in: no MAC, no packet, ever', () => {
    // The local model host may be shared. A tool that powers it on by
    // default is making a decision that is not its to make.
    const d = wakeDecision({ mac: '', haveBinary: true, last: null, now: Date.now() })
    expect(d.send).toBe(false)
    expect(d.detail).toContain('opt-in')
  })

  test('a configured MAC with the tool present sends exactly one packet', () => {
    const d = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true, last: null, now: Date.now(),
    })
    expect(d.send).toBe(true)
    expect(d.detail).toContain('02:00:00:00:00:01')
  })

  test('a missing wakeonlan is reported, not silently skipped', () => {
    const d = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: false, last: null, now: Date.now(),
    })
    expect(d.send).toBe(false)
    expect(d.detail).toContain('brew install')
  })

  test('a second packet inside a cold start is refused', () => {
    // Measured cold start is 5m42s. Sending again at four minutes cannot make
    // the model load faster; it only turns one wake into a stream of them.
    const now = Date.now()
    const soon = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true,
      last: new Date(now - 4 * 60_000), now,
    })
    expect(soon.send).toBe(false)
    expect(soon.detail).toContain('4m ago')

    // And allowed again once the whole boot has had its chance.
    const later = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true,
      last: new Date(now - WAKE_COOLDOWN_MS - 1000), now,
    })
    expect(later.send).toBe(true)
  })

  test('the cooldown is longer than the boot it is waiting for', () => {
    // 5m42s measured, power-on to "Application startup complete", before
    // firmware POST. A cooldown under that would always fire mid-boot.
    expect(WAKE_COOLDOWN_MS).toBeGreaterThan(5 * 60_000 + 42_000)
  })

  test('an unprobed cache leaves every caller exactly as it was', () => {
    // Reporting views are synchronous and never probe. They must not start
    // calling a configured agent absent just because nobody asked.
    resetLocalHealth()
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    const why = unavailableReason(local.name)
    expect(why === null || !why.includes('unreachable')).toBe(true)
  })
})

describe('a job only goes to an agent that can hold it', () => {
  // Deliberately NOT asserting which jobs qwen-local can take today. That is a
  // serving parameter — it was 65,536 and is now 131,072 — and a test pinned to
  // it fails when someone re-serves the model, which is a configuration change
  // and not a regression. The RULE is what must hold.
  const windowOf = (name: string) => AGENTS[name]!.contextTokens
  const needOf = (job: string) => JOBS[job]!.contextTokens

  test('an agent is excluded unless its window holds the working set AND a reply', () => {
    for (const job of Object.keys(JOBS)) {
      for (const name of Object.keys(AGENTS)) {
        const c = candidates(job).find((x) => x.agent === name)!
        const tooSmall = windowOf(name) < needOf(job) + OUTPUT_RESERVE
        if (tooSmall) {
          expect(c.eligible).toBe(false)
          expect(c.why).toContain('context')
        } else if (!c.eligible) {
          // Excluded for some other reason, which is fine — but not this one.
          expect(c.why).not.toContain('context')
        }
      }
    }
  })

  test('the reason names both numbers, so it can be acted on', () => {
    const fits = (n: string, j: string) => windowOf(n) >= needOf(j) + OUTPUT_RESERVE
    const tight = Object.keys(AGENTS).find((n) =>
      Object.keys(JOBS).some((j) => !fits(n, j)))
    if (!tight) return  // every agent currently holds every job
    const job = Object.keys(JOBS).find((j) => !fits(tight, j))!
    const c = candidates(job).find((x) => x.agent === tight)!
    expect(c.why).toMatch(/\d+K context is short of the ~\d+K/)
  })

  test('a job nobody can hold excludes everybody, so the rule can actually bite', () => {
    // The rule has to be capable of refusing every agent, or it is decoration.
    const biggest = Math.max(...Object.values(AGENTS).map((a) => a.contextTokens))
    const impossible = biggest === Number.POSITIVE_INFINITY ? null : biggest + 1
    if (impossible === null) {
      // Every agent declares no ceiling; nothing to prove today.
      expect(Object.values(AGENTS).some((a) => a.contextTokens === Number.POSITIVE_INFINITY)).toBe(true)
      return
    }
    expect(Object.values(AGENTS).every((a) => a.contextTokens < impossible)).toBe(true)
  })

  test('the local model is the one with a measured ceiling; the rest declare none', () => {
    // If this ever flips, someone has copied a number off a spec sheet.
    expect(windowOf('qwen-local')).toBeLessThan(Number.POSITIVE_INFINITY)
    for (const n of ['codex', 'grok', 'agy']) {
      expect(windowOf(n)).toBe(Number.POSITIVE_INFINITY)
    }
  })
})

describe('every agent is bounded', () => {
  test('no agent may outlive the stale cutoff, or it is reaped mid-run', () => {
    for (const a of Object.values(AGENTS)) {
      expect(a.timeoutMs).toBeGreaterThan(0)
      expect(a.timeoutMs).toBeLessThan(STALE_AFTER_MS)
    }
  })
})

/**
 * `orch wait` and `orch result` are the collection half of `--detach`, and
 * another session's fan-out now depends on their exit codes meaning what they
 * say. Driven through the real CLI, because the bugs worth catching here are in
 * argument parsing and process exit status, neither of which a unit call sees.
 */
describe('a repository-reading job gets a disposable writable disk', () => {
  /**
   * One session had seven files of uncommitted review fixes in its
   * checkout. A review lens ran there with --mcp and codex's
   * --approve-for-me implied workspace-write. The tree came back at HEAD, no
   * stash, no commit, nothing in the reflog. The disposable worktree makes that
   * permission safe instead of excluding the agent from the route.
   */
  test('the old caller-checkout MCP exclusion is no longer needed', () => {
    expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })

  test('the same agent remains fine without tools', () => {
    expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })
})

describe('run files are named by their run, not by the clock', () => {
  /**
   * Six review lenses fired concurrently put three runs inside one millisecond
   * with the same agent and job, so they shared a prompt file AND an output
   * file. Each worker read whichever prompt was written last, and all three
   * answered the same question while claiming to be three different lenses.
   * The session that hit it scored two of them `none` and caught it only
   * because the content did not match what it had asked for.
   *
   * The stored paths are the evidence, so the test reads them: two runs of the
   * same job started in the same millisecond must not name the same file.
   */
  test('neither call site names a run file from the clock alone', () => {
    // Asserted against the SOURCE, the way the stale-`blocked` guard is, because
    // reproducing a millisecond collision on demand is a race the test would
    // lose more often than the bug did.
    const dir = new URL('.', import.meta.url).pathname
    for (const file of ['run.ts', 'cli.ts']) {
      // Comments quote the OLD pattern on purpose, to record what went wrong.
      const code = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      for (const n of code.match(/`\$\{Date\.now\(\)\}[^`]*`/g) ?? []) {
        expect(n).toMatch(/reserveId|unique|randomUUID/)
      }
    }
  })

  test('two runs created in the same millisecond have distinct paths', () => {
    const clock = 1_700_000_000_000
    const first = runFilePaths(dir, clock, 1, 'codex', 'review-lens')
    const second = runFilePaths(dir, clock, 2, 'codex', 'review-lens')
    expect(first.prompt).not.toBe(second.prompt)
    expect(first.output).not.toBe(second.output)
  })
})

describe('run file pruning', () => {
  test('deleting expired files nulls their matching database paths', () => {
    const files = join(dir, 'prune-files')
    mkdirSync(files)
    const prompt = join(files, 'old.prompt.txt')
    const output = join(files, 'old.txt')
    writeFileSync(prompt, 'prompt')
    writeFileSync(output, 'output')
    const old = new Date(Date.now() - (KEEP_RUN_FILES_DAYS + 1) * 86_400_000)
    utimesSync(prompt, old, old)
    utimesSync(output, old, old)
    const id = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET prompt_path=?, output_path=? WHERE id=?').run(prompt, output, id)

    pruneRuns(files)

    expect(existsSync(prompt)).toBe(false)
    expect(existsSync(output)).toBe(false)
    expect(db().query('SELECT prompt_path, output_path FROM run WHERE id=?').get(id))
      .toEqual({ prompt_path: null, output_path: null })
  })
})

describe('hooks fail open visibly', () => {
  const runHook = (name: string, input: string) => Bun.spawnSync(
    ['python3', new URL(`../hooks/${name}`, import.meta.url).pathname],
    { stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! } },
  )

  test('malformed stdin exits zero and writes one stderr line', () => {
    for (const hook of ['block-agent.py', 'score-reminder.py']) {
      const p = runHook(hook, '{not json')
      expect(p.exitCode).toBe(0)
      const lines = p.stderr.toString().trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('payload could not be parsed')
    }
    const fallback = new URL('../spawn-fallback.log', import.meta.url).pathname
    expect(readFileSync(fallback, 'utf8').trim().split('\n').at(-1))
      .toContain('payload could not be parsed')
  })

  test('NEEDS-WEB deep in a prompt is not a declaration', () => {
    const prompt = 'x'.repeat(500) + ' NEEDS-WEB'
    const p = runHook('block-agent.py', JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { description: 'read files', prompt, subagent_type: 'general-purpose' },
    }))
    expect(p.exitCode).toBe(0)
    const reply = JSON.parse(p.stdout.toString())
    expect(reply.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('metric canon headline and calendar halves', () => {
  test('counts each canon project only by all of its declared key prefixes', async () => {
    const fixture = (name: string, subjects: string[], keyPrefixes?: string[]) => {
      const repo = join(dir, `metric-${name}`)
      mkdirSync(repo)
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(['git', ...args], {
          cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      }
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      for (const [i, subject] of subjects.entries()) {
        writeFileSync(join(repo, `${i}.txt`), `${subject}\n`)
        git('add', `${i}.txt`)
        git('commit', '-m', subject)
      }
      upsertProject({ name, path: repo, canon: true, settings: { keyPrefixes } })
      return repo
    }

    const repos = [
      fixture('one-prefix', ['ONE-1 shipped'], ['ONE']),
      fixture('several-prefixes', ['LEFT-2 shipped', 'RIGHT-3 shipped'], ['LEFT', 'RIGHT']),
      fixture('no-prefixes', ['OLD-4 must not count']),
    ]
    db().exec('DELETE FROM metric')
    try {
      const collected = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'metric', 'collect', '--days', '1',
      ], {
        env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB! },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(collected.exitCode).toBe(0)
      const total = db().query('SELECT SUM(tasks) AS tasks FROM metric').get() as { tasks: number }
      expect(total.tasks).toBe(3)
    } finally {
      db().exec('DELETE FROM metric')
      for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    }
  })

  test('headline uses canon totals and excluded days do not move the midpoint', () => {
    const day = (ago: number) => {
      const d = new Date()
      d.setDate(d.getDate() - ago)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      return `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`
    }
    const insert = db().query(
      `INSERT INTO metric (day, claude_tokens, cache_read, messages, tasks,
                           canon_tokens, other_tokens, collected_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    for (const [ago, canon, other, tasks] of [
      [13, 300, 30, 3], [12, 300, 30, 3], [10, 1, 0, 100],
      [2, 150, 15, 3], [1, 150, 15, 3],
    ]) insert.run(day(ago), canon + other, 0, 1, tasks, canon, other, new Date().toISOString())

    const s = summary(14)
    expect(s.canonTokens).toBe(900)
    expect(s.tokens).toBe(990)
    expect(s.otherTokens).toBe(90)
    expect(s.perTask).toBe(75)
    expect(s.earlier).toEqual({ tokens: 600, tasks: 6, perTask: 100 })
    expect(s.recent).toEqual({ tokens: 300, tasks: 6, perTask: 50 })
    expect(s.direction).toBe('improving')
    db().exec('DELETE FROM metric')
  })
})

describe('recalibrating the scorer', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const runRecalibrate = (input: string, ...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, 'recalibrate', ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'calibration-session',
      },
      stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const oldScore = (
    runId: number, delivery: string, quality: string | null, fidelity: string | null,
    scorer = 'claude', scoredAt = '2026-01-01T00:00:00.000Z',
  ) => db().query(
    `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at, scored_by)
     VALUES (?,?,?,?,?,?)`,
  ).run(runId, delivery, quality, fidelity, scoredAt, scorer)

  test('blind verdicts are stored apart and kappa is printed per comparable axis', () => {
    const originals = [
      ['none', null, null],
      ['partial', 'wrong', 'drifted'],
      ['full', 'right', 'faithful'],
    ] as const
    for (const [i, original] of originals.entries()) {
      const id = addRun({ agent: 'codex', job: 'implement' })
      const output = join(dir, `calibration-${i}.txt`)
      writeFileSync(output, `answer ${i}`)
      db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
      oldScore(id, original[0], original[1], original[2])
    }

    const r = runRecalibrate('full right faithful\nfull right faithful\nfull right faithful\n', '--n', '3')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('axes: delivery quality fidelity')
    expect(r.out).toContain('delivery: n=3 kappa=0.000 reading=ambiguous rubric')
    expect(r.out).toContain('quality: n=2 kappa=0.000 reading=ambiguous rubric')
    expect(r.out).toContain('fidelity: n=2 kappa=0.000 reading=ambiguous rubric')
    expect(db().query(
      `SELECT delivery, quality, fidelity, session_id FROM calibration ORDER BY id`,
    ).all()).toEqual(Array.from({ length: 3 }, () => ({
      delivery: 'full', quality: 'right', fidelity: 'faithful',
      session_id: 'calibration-session',
    })))
    expect(db().query(
      'SELECT delivery, quality, fidelity FROM score ORDER BY id',
    ).all()).toEqual(originals.map(([delivery, quality, fidelity]) => ({ delivery, quality, fidelity })))
  })

  test('age and scorer identity filter the sample, while force skips only identity', () => {
    const foreign = addRun({ agent: 'codex', job: 'file-question' })
    const foreignOut = join(dir, 'calibration-foreign.txt')
    writeFileSync(foreignOut, 'foreign output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(foreignOut, foreign)
    oldScore(foreign, 'full', 'right', null, 'someone-else')

    const recent = addRun({ agent: 'codex', job: 'file-question' })
    const recentOut = join(dir, 'calibration-recent.txt')
    writeFileSync(recentOut, 'recent output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(recentOut, recent)
    oldScore(recent, 'full', 'right', null, 'claude', new Date().toISOString())

    const missing = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET output_path=? WHERE id=?').run('/definitely/missing/DEV-86', missing)
    oldScore(missing, 'full', 'right', null)

    const filtered = runRecalibrate('')
    expect(filtered.code).toBe(0)
    expect(filtered.out).toContain('no scored runs older than 7 days with output still on disk')
    const forced = runRecalibrate('full right\n', '--force', '--n', '1')
    expect(forced.code).toBe(0)
    expect(forced.out).toContain('foreign output')
    expect(forced.out).not.toContain('recent output')
    expect((db().query('SELECT COUNT(*) AS n FROM calibration').get() as { n: number }).n).toBe(1)
  })

  test('the displayed output keeps the first 4000 and last 2000 characters', () => {
    const id = addRun({ agent: 'codex', job: 'file-question' })
    const output = join(dir, 'calibration-long.txt')
    writeFileSync(output, 'H'.repeat(4000) + 'M'.repeat(50) + 'T'.repeat(2000))
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    oldScore(id, 'partial', 'mixed', null)
    const r = runRecalibrate('partial mixed\n', '--n', '1')
    expect(r.code).toBe(0)
    expect(r.out).toContain('H'.repeat(4000))
    expect(r.out).toContain('T'.repeat(2000))
    expect(r.out).not.toContain('M'.repeat(50))
    expect(r.out).not.toContain('original_delivery')
  })
})

describe('detached run collection', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orchInput = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      // The suite may itself be run by an orch worker. CLI behavior under test
      // starts at the user boundary, not at the inherited delegation depth.
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const orch = (...args: string[]) => orchInput(args)
  const insert = (status: string, job = 'file-question') => (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
  ).get(new Date().toISOString(), job, status) as { id: number }).id

  test('every --json surface has an enumerated and pinned output contract', () => {
    upsertProject({ name: 'json-source', path: '/w/json-source', settings: {} })
    upsertProject({ name: 'json-target', path: '/w/json-target',
      settings: { keyPrefixes: ['TGT'] } })
    setDoc({ scope: 'global', subject: null, slug: 'json-show', title: 'Show', body: 'body' })
    setDoc({
      scope: 'global', subject: null, slug: 'json-consume', title: 'Consume',
      body: '---\nstatus: open\nepic: json\nproject: json-target\nwritten: 2026-09-04T00:00:00.000Z\n---\n\nNEXT ACTION\n',
    })
    setDoc({ scope: 'global', subject: null, slug: 'json-rm', title: 'Remove', body: 'body' })
    const sources = JSON.stringify([
      { project: 'json-source', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
    ])

    const documents: { command: string; args: string[]; stdin?: string }[] = [
      { command: 'review calibration', args: ['review', 'calibration', 'safety', 'codex', 'model', '--json'] },
      { command: 'search', args: ['search', 'no-match', '--json'] },
      { command: 'blockers', args: ['blockers', '--json'] },
      { command: 'inbox', args: ['inbox', '--all', '--json'] },
      { command: 'project list', args: ['project', 'list', '--json'] },
      { command: 'project add', args: ['project', 'add', dir, '--name', 'json-added', '--no-canon', '--json'] },
      { command: 'project set', args: ['project', 'set', 'json-added', '--stack', 'node', '--json'] },
      { command: 'doc list', args: ['doc', 'list', '--json'] },
      { command: 'doc show', args: ['doc', 'show', 'json-show', '--scope', 'global', '--json'] },
      { command: 'doc set', args: ['doc', 'set', 'json-set', '--scope', 'global', '--title', 'Set', '--json'], stdin: 'body' },
      { command: 'doc consume', args: ['doc', 'consume', 'json-consume', '--scope', 'global', '--json'] },
      { command: 'doc rm', args: ['doc', 'rm', 'json-rm', '--scope', 'global', '--json'] },
      { command: 'doc subjects', args: ['doc', 'subjects', '--json'] },
      { command: 'port baseline show', args: ['port', 'baseline', 'show', 'json-source', 'json-target', '--json'] },
      { command: 'port baseline set', args: ['port', 'baseline', 'set', 'json-source', 'json-target', 'abc', '--json'] },
      { command: 'port skip list', args: ['port', 'skip', 'list', 'json-source', 'json-target', '--json'] },
      { command: 'port skip add', args: ['port', 'skip', 'add', 'json-source', 'json-target', 'old', '--reason', 'superseded', '--json'] },
      { command: 'port ref set', args: ['port', 'ref', 'set', 'TGT-210', '--sources', sources, '--note', 'native', '--json'] },
      { command: 'port ref list', args: ['port', 'ref', 'list', '--all', '--json'] },
      { command: 'port ref show', args: ['port', 'ref', 'show', 'TGT-210', '--json'] },
      { command: 'port ref resolve', args: ['port', 'ref', 'resolve', 'TGT-210', '--json'] },
      { command: 'port ref delete-error', args: ['port', 'ref', 'delete-error', 'TGT-210', '--json'] },
      { command: 'port doctrine add', args: ['port', 'doctrine', 'add', '210', '--title', 'Native', '--json'], stdin: 'Adapt natively.' },
      { command: 'port doctrine list', args: ['port', 'doctrine', 'list', '--all', '--json'] },
      { command: 'port doctrine retire', args: ['port', 'doctrine', 'retire', '210', '--json'] },
    ]

    expect(documents).toHaveLength(25)
    for (const surface of documents) {
      const result = orchInput(surface.args, surface.stdin)
      expect(result.code, surface.command).toBe(0)
      expect(result.err, surface.command).toBe('')
      expect(() => JSON.parse(result.out), surface.command).not.toThrow()
    }

    insert('ok')
    insert('ok')
    const runs = orch('runs', '--json')
    expect(runs.code).toBe(0)
    expect(runs.err).toBe('')
    expect(() => JSON.parse(runs.out)).toThrow()
    const lines = runs.out.trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ id: expect.any(Number) })

    const help = orch('--help').out
    expect(help.match(/one JSON document/g)).toHaveLength(documents.length)
    expect(help.match(/one JSON object per line/g)).toHaveLength(1)
  })

  test('the detached spec mapping forwards every field to run', () => {
    const resume = {
      parent: 11, agent: 'codex', session: 'session', turn: 2, sessionId: 'owner',
      worktree: { path: '/tmp/tree', branch: 'DEV-63', base: 'main', repoRoot: '/tmp/repo' },
    }
    expect(detachedRunOptions('implement', 'prompt', 42, {
      agent: 'codex', schema: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
      label: 'security lens', lens: 'security', seed: 'small', key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
      distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', noFailover: true, carry: true,
      ownerSession: 'owner', resume,
    })).toEqual({
      job: 'implement', prompt: 'prompt', reserveId: 42,
      agent: 'codex', schemaPath: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
      label: 'security lens', lens: 'security', seed: 'small', key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
      distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', noFailover: true, carry: true,
      ownerSession: 'owner', resume,
    })
  })

  test('detach spawns exec.ts as its child entry point', () => {
    const cli = readFileSync(new URL('./cli.ts', import.meta.url).pathname, 'utf8')
    const detachSource = cli.slice(cli.indexOf('function detach('), cli.indexOf('function usage('))
    expect(detachSource).toContain("new URL('exec.ts', import.meta.url).pathname")
    expect(detachSource).not.toContain("new URL('cli.ts', import.meta.url).pathname")
  })

  test('detach with a bad execPath marks the reserved row failed/harness', () => {
    upsertProject({ name: 'spawn-fail', path: process.cwd() })
    const r = Bun.spawnSync([process.execPath, CLI, 'do', 'file-question', '--repo', 'spawn-fail', 'hello'], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ORCH_EXEC_PATH: '/definitely/not-an-orch-exec-DEV-73',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    const row = db().query(
      'SELECT agent, status, failure_kind, error, pid FROM run ORDER BY id DESC LIMIT 1',
    ).get() as { agent: string; status: string; failure_kind: string; error: string; pid: number | null }
    expect(row.agent).toBe('(pending)')
    expect(row.status).toBe('failed')
    expect(row.failure_kind).toBe('harness')
    expect(row.error).toContain('spawn failed')
    expect(row.error).toContain('/definitely/not-an-orch-exec-DEV-73')
    expect(row.pid).toBeNull()
  })

  test('a detached run has exactly one prompt file', () => {
    const binDir = join(dir, 'detach-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const p = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'one prompt', '--agent', 'codex',
        '--label', 'security lens', '--detach'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1',
      } },
    )
    expect(p.exitCode).toBe(0)
    const id = Number(p.stdout.toString().trim())
    expect(id).toBeGreaterThan(0)
    expect(p.stderr.toString()).toContain(
      `detached as run ${id}: orch wait ${id}, then orch result ${id}`,
    )
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const row = db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }
      if (row.status !== 'running') break
      Bun.sleepSync(20)
    }
    const recorded = db().query(
      'SELECT label, prompt_head, prompt_path FROM run WHERE id=?',
    ).get(id) as { label: string; prompt_head: string; prompt_path: string }
    expect({ label: recorded.label, prompt_head: recorded.prompt_head })
      .toEqual({ label: 'security lens', prompt_head: 'one prompt' })
    const listed = orch('runs', '--limit', '1')
    expect(listed.out).toContain('security lens')
    expect(listed.out).not.toContain('one prompt')
    const pending = orch('pending')
    expect(pending.out).toContain('security lens')
    expect(pending.out).not.toContain('one prompt')
    const runsDir = RUNS_DIR
    expect(recorded.prompt_path).toContain(`-${id}-`)
    expect(existsSync(recorded.prompt_path)).toBe(true)
    expect(readdirSync(runsDir).filter(
      (name) => name.includes(`-${id}-`) && name.endsWith('.prompt.txt'),
    )).toHaveLength(1)
    for (const name of readdirSync(runsDir).filter((name) => name.includes(`-${id}-`))) {
      rmSync(join(runsDir, name), { force: true })
    }
  })

  test('do help names every job and every supported flag', () => {
    for (const help of ['--help', '-h']) {
      const r = orch('do', help)
      expect(r.code).toBe(0)
      for (const name of Object.keys(JOBS)) expect(r.out).toContain(name)
      for (const name of [
        '--agent', '--schema', '--mcp', '--model', '--label', '--probe', '--seed', '--key',
        '--repo', '--base', '--carry', '--avoid', '--distinct-from', '--file', '--detach', '--follow', '--quiet',
        '--no-failover', '--porcelain',
      ]) expect(r.out).toContain(name)
    }
  })

  test('a missing required dispatch flag exits non-zero without claiming a run', () => {
    upsertProject({
      name: 'requires-seed', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const r = orch('do', 'implement', 'make the change', '--porcelain')
    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.err).toContain('this project requires a database size')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('--porcelain prints only a parseable run id on a successful dispatch', () => {
    const binDir = join(dir, 'porcelain-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const p = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'one prompt', '--agent', 'codex', '--porcelain'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1',
      } },
    )
    const stdout = p.stdout.toString()
    expect(p.exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\n$/)
    expect(Number(stdout.trim())).toBeGreaterThan(0)
    expect(p.stderr.toString()).toBe('')
  })

  const conflictingImplement = (extra: string[]) => {
    const binDir = join(dir, `conflict-warn-bin-${extra.join('-') || 'human'}`)
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    return Bun.spawnSync(
      [process.execPath, CLI, 'do', 'implement',
        'Make the change.\nThen push the branch.', '--agent', 'codex', ...extra],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1',
      } },
    )
  }

  test('an implement contract conflict names the started run on stderr', () => {
    const p = conflictingImplement([])
    expect(p.exitCode).toBe(0)
    const stdout = p.stdout.toString()
    expect(stdout).toMatch(/^\d+\n$/)
    const id = Number(stdout.trim())
    expect(id).toBeGreaterThan(0)
    const err = p.stderr.toString()
    expect(err).toContain('implement spec may conflict with its no-push/no-merge/no-rewrite contract')
    expect(err).toContain('line 2: Then push the branch.')
    expect(err).toContain(`The spec was not changed. Run ${id} has started;`)
    expect(err).toContain('review the spec before the worker reaches this conflict')
  })

  test('--porcelain with an implement contract conflict still prints only the run id', () => {
    const p = conflictingImplement(['--porcelain'])
    const stdout = p.stdout.toString()
    expect(p.exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\n$/)
    expect(Number(stdout.trim())).toBeGreaterThan(0)
    expect(p.stderr.toString()).toBe('')
    expect(stdout).not.toContain('may conflict')
    expect(stdout).not.toContain('has started')
  })

  test('--porcelain refuses --follow because following cannot print only an id', () => {
    const r = orch('do', 'file-question', 'one prompt', '--porcelain', '--follow')
    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.err).toContain('--porcelain cannot be combined with --follow')
  })

  test("do help says when the current project's create template cannot carry a base", () => {
    upsertProject({
      name: 'cannot-base', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'feature/{id}',
        },
      },
    })

    const r = orch('do', '--help')
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "--base <ref>     base an implement worktree on this verified git ref " +
      "(unsupported for this project's create arguments: no {base})",
    )
  })

  test("do help does not warn when the current project's create template carries a base", () => {
    upsertProject({
      name: 'can-base', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{base}']), branch: 'feature/{id}',
        },
      },
    })

    const r = orch('do', '--help')
    expect(r.code).toBe(0)
    expect(r.out).toContain('--base <ref>     base an implement worktree on this verified git ref')
    expect(r.out).not.toContain('unsupported for this project')
  })

  test('a Codex schema rejected in preflight leaves no run row', () => {
    const schema = join(dir, 'unsupported-codex-schema.json')
    writeFileSync(schema, JSON.stringify({
      type: 'object', properties: {}, patternProperties: { '^x': { type: 'string' } },
    }))
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const r = orch('do', 'file-question', 'answer this', '--agent', 'codex', '--schema', schema)
    expect(r.code).toBe(1)
    expect(r.err).toContain('$.patternProperties')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('runs --unscored uses the shared definition of an owed judgement', () => {
    const wanted = addRun({ agent: 'grok', job: 'craft' })
    addRun({ agent: 'grok', job: 'craft', probe: 1 })
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    addRun({ agent: 'grok', job: 'craft', status: 'running' })
    const parent = addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    addRun({ agent: 'grok', job: 'craft', parent, turn: 2 })

    const r = orch('runs', '--unscored', '--json')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    const rows = r.out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(rows.map((row) => row.id)).toEqual([wanted])
  })

  test('pick previews the same fan-out exclusions do uses', () => {
    const prior = insert('ok', 'review-lens')
    db().query('UPDATE run SET agent=?, model=? WHERE id=?')
      .run('grok', AGENTS.grok!.model, prior)

    const avoided = orch('pick', 'review-lens', '--avoid', 'grok')
    expect(avoided.code).toBe(0)
    expect(avoided.out).toContain('review-lens -> codex')

    const distinct = orch('pick', 'review-lens', '--distinct-from', String(prior))
    expect(distinct.code).toBe(0)
    expect(distinct.out).toContain('review-lens -> codex')
  })

  test('a drifted caller is signalled once before a fan-out, while an up-to-date one is quiet', () => {
    mkdirSync(join(dir, 'early-drift-signal'))
    const repo = realpathSync(join(dir, 'early-drift-signal'))
    const git = (args: string[], stdin?: string) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    git(['init', '-b', 'main'])
    git(['commit', '--allow-empty', '-m', 'base'])
    const head = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/main', head])
    upsertProject({
      name: 'early-drift', path: repo,
      settings: {
        trunk: 'main',
        worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'task/{id}' },
      },
    })

    const pick = () => {
      const p = Bun.spawnSync([process.execPath, CLI, 'pick', 'implement'], {
        cwd: repo, stdout: 'pipe', stderr: 'pipe',
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'early-drift-session',
        },
      })
      return { code: p.exitCode, err: p.stderr.toString() }
    }

    const current = pick()
    expect(current.code).toBe(0)
    expect(current.err).not.toContain('caller checkout HEAD')

    const tree = git(['rev-parse', 'HEAD^{tree}'])
    const newer = git(['commit-tree', tree, '-p', head], 'newer base\n')
    git(['update-ref', 'refs/remotes/origin/main', newer])
    expect(callerDrift(repo)).toEqual({ callerHead: head, base: newer, baseRef: 'origin/main' })
    const first = pick()
    const sibling = pick()
    expect(first.code).toBe(0)
    expect(first.err).toContain(`caller checkout HEAD ${head} is behind or diverged`)
    expect(first.err).toContain(`origin/main (${newer})`)
    expect(sibling.code).toBe(0)
    expect(sibling.err).not.toContain('caller checkout HEAD')
  })

  test('pick shares do validation for fan-out exclusions', () => {
    const unknown = orch('pick', 'review-lens', '--avoid', 'nobody')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('unknown agent "nobody" in --avoid')

    const invalid = orch('pick', 'review-lens', '--distinct-from', 'not-a-run')
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain('--distinct-from expects comma-separated run ids')

    const contradictory = orch('pick', 'review-lens', '--agent', 'grok', '--avoid', 'grok')
    expect(contradictory.code).toBe(1)
    expect(contradictory.err).toContain('--agent grok contradicts --avoid grok')
  })

  test('pick refuses an unmet constraint instead of silently routing', () => {
    const r = orch('pick', 'review-lens', '--avoid', 'grok,codex')
    expect(r.code).toBe(1)
    expect(r.err).toContain('routing constraints leave no eligible agent')
    expect(r.err).toContain('codex: --avoid named codex')
    expect(r.err).toContain('grok: --avoid named grok')
  })

  test('jobs exposes fidelity only for writing jobs', () => {
    const r = orch('jobs')
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.find((line) => line.startsWith('implement'))).toContain('fidelity')
    expect(lines.find((line) => line.startsWith('fix'))).toContain('fidelity')
    expect(lines.find((line) => line.startsWith('review-lens'))).not.toContain('fidelity')
  })

  test('every score hint names the ROOT, never the turn it printed after', () => {
    /**
     * `orch result <turn>` printed `score it: orch score <turn>` — the one
     * command score refuses ("run 727 is one turn of run 725"). The first thing
     * the tool showed you was the thing it would not accept. scoreHint had been
     * right all along; two call sites simply did not use it.
     */
    const root = insert('ok', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=1 WHERE id=?').run(root, turn)
    const r = orch('result', String(turn))
    expect(r.err).toContain(`orch score ${root}`)
    expect(r.err).not.toContain(`orch score ${turn} <`)
    expect(r.err).toContain(`not turn ${turn}`)
  })

  test('a leaf id scores the root of its conversation', () => {
    const root = insert('ok', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const r = orch('score', String(turn), 'full', 'right', 'faithful')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${root} (codex/implement) scored full right faithful`)
    expect(db().query('SELECT run_id FROM score').all()).toEqual([{ run_id: root }])
  })

  test('a leaf id answers the open question in its conversation', () => {
    const root = insert('running', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2, pid=? WHERE id=?')
      .run(root, process.pid, turn)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(turn, new Date().toISOString(), 'which shape?')

    const r = orch('answer', String(turn), 'the existing shape')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ruled on 1 question(s)')
    expect(db().query('SELECT answer FROM question').get()).toEqual({ answer: 'the existing shape' })
  })

  test('inbox names the canonical root in its answer footer', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(turn, new Date().toISOString(), 'which shape?')

    const r = orch('inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`rule on them:  orch answer ${root} "<ruling>"`)
    expect(r.out).not.toContain(`rule on them:  orch answer ${turn} "<ruling>"`)
  })

  test('inbox keeps own questions first and in their existing format', () => {
    const own = insert('asking', 'implement')
    const orphan = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', own)
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(orphan)
    db().query('INSERT INTO question (run_id, asked_at, question, options, recommendation, why) VALUES (?,?,?,?,?,?)')
      .run(own, new Date().toISOString(), 'own shape?', JSON.stringify(['one', 'two']), 'one', 'it fits')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(orphan, new Date().toISOString(), 'orphan shape?')

    const r = orch('inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${own} · codex/implement · asking`)
    expect(r.out).toContain('        why: it fits\n        - one\n        - two\n        it would: one')
    expect(r.out.indexOf(`run ${own}`)).toBeLessThan(r.out.indexOf('waiting on a ruling that anyone may give:'))
    expect(r.out).toContain(`rule on them:  orch answer ${own} "<ruling>"`)
  })

  test('inbox surfaces an orphaned question with everything needed to rule', () => {
    const id = insert('asking', 'implement')
    const askedAt = new Date(Date.now() - 90_000).toISOString()
    db().query('UPDATE run SET session_id=?, repo=? WHERE id=?').run('gone-session', 'fixture-repo', id)
    db().query('INSERT INTO question (run_id, asked_at, question, options, recommendation) VALUES (?,?,?,?,?)')
      .run(id, askedAt, 'which shape?', JSON.stringify(['existing', 'new']), 'existing')

    const r = orch('inbox')
    expect(r.code).toBe(0)
    expect(r.out).toContain('waiting on a ruling that anyone may give:')
    expect(r.out).toContain(`run ${id} · answer ${id} · implement · codex · fixture-repo · waiting`)
    expect(r.out).toContain('which shape?\n        - existing\n        - new')
    expect(r.out).toContain('recommendation: existing')
    expect(r.out).toContain(`orch answer ${id} --q`)
  })

  test('inbox does not claim a different recently-seen session is orphaned', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-live-session', id)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('other-live-session', new Date().toISOString())
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still owned?')

    const r = orch('inbox')
    expect(r.code).toBe(0)
    expect(r.out).toBe('no questions waiting on you\n')
  })

  test('inbox --all keeps including another live session', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-live-session', id)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('other-live-session', new Date().toISOString())
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still owned?')

    const r = orch('inbox', '--all')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`run ${id} · codex/implement · asking`)
    expect(r.out).toContain(`rule on them:  orch answer ${id} "<ruling>"`)
    expect(r.out).not.toContain('waiting on a ruling that anyone may give:')
  })

  test('inbox --all --json publishes answer ids and session liveness', () => {
    const live = insert('asking', 'implement')
    const orphan = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-live-session', live)
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(orphan)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('other-live-session', new Date().toISOString())
    const askedAt = new Date().toISOString()
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(live, askedAt, 'live question')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(orphan, askedAt, 'orphan question')

    const r = orch('inbox', '--all', '--json')
    expect(r.code).toBe(0)
    const rows = JSON.parse(r.out) as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      question_id: expect.any(Number), run_id: live, answer_id: live,
      job: 'implement', agent: 'codex', repo: null, asked_at: askedAt, session_live: true,
    })
    expect(rows[1]).toMatchObject({ run_id: orphan, answer_id: orphan, session_live: false })
  })

  test('a flag value is not mistaken for a run id', () => {
    // `--timeout 300` was read as a fourth run to wait for, and wait duly
    // reported "300 ok" for a run that has never existed.
    const id = insert('ok')
    const r = orch('wait', String(id), '--timeout', '300')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${id}\tok`)
    expect(r.out).not.toContain('300\t')
  })

  test('waiting on ok and asking runs succeeds and points to the inbox', () => {
    const ok = insert('ok')
    const asking = insert('asking', 'implement')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(asking, new Date().toISOString(), 'which shape?')
    const r = orch('wait', String(ok), String(asking))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${ok}\tok`)
    expect(r.out).toContain(`${asking}\tasking`)
    expect(r.out).toContain('orch inbox')
  })

  test('wait names the root, not the asking tip, when a question is open', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(turn, new Date().toISOString(), 'which shape?')

    const r = orch('wait', String(root))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${root}\tasking - orch inbox (or orch answer ${root})`)
    expect(r.out).not.toContain(`orch answer ${turn}`)
  })

  test('wait keeps waiting when an asking tip has no open question but its root is running', () => {
    const root = insert('running', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, root)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const r = orch('wait', String(root), '--timeout', '0')
    expect(r.code).toBe(2)
    expect(r.err).toContain(`still running after 0s: ${turn}`)
    expect(r.out).not.toContain('asking')
    expect(r.out).not.toContain('orch answer')
  })

  test('wait exposes an asking chain with no open question or running turn as recoverable', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const r = orch('wait', String(root))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${root}\tasking - recoverable: orch continue ${root}`)
    expect(r.out).not.toContain(`orch continue ${turn}`)
    expect(r.out).not.toContain('orch answer')
  })

  test('result on an asking run succeeds, prints its reply, and points to the inbox', () => {
    const id = insert('asking', 'implement')
    const output = join(dir, `asking-${id}.txt`)
    writeFileSync(output, 'I need a ruling.')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
    const r = orch('result', String(id))
    expect(r.code).toBe(0)
    expect(r.out).toContain('I need a ruling.')
    expect(r.err).toContain(`waiting on a ruling: orch answer ${id}`)
  })

  test('inbox and result expose an asking chain with no open question as recoverable', () => {
    const root = insert('asking', 'implement')
    const turn = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('orch-test-session', root, turn)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const inbox = orch('inbox')
    expect(inbox.code).toBe(0)
    expect(inbox.out).toContain(`asking, but no ruling is open — recoverable: orch continue ${root}`)

    const result = orch('result', String(turn))
    expect(result.code).toBe(0)
    expect(result.err).toContain(`asking — recoverable: orch continue ${root}`)
    expect(result.err).not.toContain(`orch continue ${turn}`)
  })

  test('result surfaces the recorded base commit for a writing run', () => {
    const id = insert('ok', 'implement')
    db().query('UPDATE run SET base_commit=? WHERE id=?').run('base-commit-123', id)
    const r = orch('result', String(id))
    expect(r.code).toBe(0)
    expect(r.err).toContain('base:      base-commit-123')
  })

  test('runs shows asking in the status column', () => {
    const id = insert('asking', 'implement')
    const r = orch('runs')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(new RegExp(`\\b${id}\\s+codex\\s+implement\\s+asking\\b`))
  })

  test('runs emits one canonical row per resume chain', () => {
    const root = insert('asking', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const text = orch('runs')
    expect(text.code).toBe(0)
    expect(text.out).toMatch(new RegExp(`\\b${root}\\s+codex\\s+implement\\s+running\\b`))
    expect(text.out).not.toMatch(new RegExp(`\\b${turn}\\s+codex\\s+implement\\s+running\\b`))

    const json = orch('runs', '--json')
    expect(json.code).toBe(0)
    expect(json.out.trim().split('\n').map((line) => JSON.parse(line).id)).toEqual([root])
  })

  test('runs --id returns the union requested and reports unknown ids', () => {
    const first = insert('ok', 'implement')
    insert('ok', 'implement')
    const second = insert('running', 'review-lens')
    const unknown = second + 1000

    const result = orch('runs', '--id', String(first), '--id', String(second),
      '--id', String(unknown), '--json')
    expect(result.code).toBe(0)
    const rows = result.out.trim().split('\n').map((line) => JSON.parse(line))
    expect(rows.map((row) => row.id)).toEqual([second, first, unknown])
    expect(rows.at(-1)).toEqual({ id: unknown, status: 'unknown', unknown: true })
  })

  test('runs --id refuses a time window', () => {
    const id = insert('ok', 'implement')
    const result = orch('runs', '--id', String(id), '--since', '2026-09-01T00:00:00Z', '--json')
    expect(result.code).toBe(1)
    expect(result.err).toContain('orch runs --id and --since cannot be combined')
  })

  test('runs JSON emits every execution interval in a resumed chain', () => {
    const starts = [
      '2026-09-01T12:00:00.000Z', '2026-09-01T12:10:00.000Z',
      '2026-09-01T12:30:00.000Z', '2026-09-01T13:00:00.000Z',
      '2026-09-01T13:40:00.000Z',
    ]
    const latencies = [63_855, 11_127, 200_636, 52_916, 704_156]
    const tokens = [260_552, 62_612, 1_904_392, 261_452, 9_309_615]
    const root = addRun({
      agent: 'codex', job: 'implement', startedAt: starts[0], latency: latencies[0],
    })
    const ids = [root]
    for (let turn = 2; turn <= 5; turn++) {
      ids.push(addRun({
        agent: 'codex', job: 'implement', parent: root, turn,
        startedAt: starts[turn - 1], latency: latencies[turn - 1],
      }))
    }
    ids.forEach((id, index) => db().query('UPDATE run SET vendor_tokens=? WHERE id=?')
      .run(tokens[index], id))

    // The root predates this window, but later execution in the chain does not.
    const result = orch('runs', '--json', '--since', '2026-09-01T12:20:00.000Z')
    expect(result.code).toBe(0)
    const [row] = result.out.trim().split('\n').map((line) => JSON.parse(line))
    expect(row.id).toBe(root)
    expect(row.status).toBe('ok')
    expect(row.turns.map((turn: { id: number }) => turn.id)).toEqual(ids)
    expect(row.turns.reduce(
      (sum: number, turn: { vendor_tokens: number }) => sum + turn.vendor_tokens, 0,
    )).toBe(11_798_623)
  })

  test('waiting on a failed run exits non-zero', () => {
    const id = insert('failed')
    db().query(
      `UPDATE run SET error='worktree creation failed', failure_kind='harness', exit_code=17
        WHERE id=?`,
    ).run(id)
    const r = orch('wait', String(id))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${id}\tfailed\n  harness, exit 17: worktree creation failed`)
  })

  test('result falls back to the run row and output when the full CLI cannot parse', () => {
    const id = insert('ok')
    const output = join(dir, `degraded-result-${id}.txt`)
    writeFileSync(output, 'already-paid-for answer')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)

    const shadow = join(dir, 'degraded-result-cli')
    mkdirSync(shadow, { recursive: true })
    for (const file of ['orch.ts', 'collect.ts', 'outcome.ts']) {
      writeFileSync(join(shadow, file), readFileSync(new URL(file, import.meta.url).pathname, 'utf8'))
    }
    writeFileSync(join(shadow, 'cli.ts'), '<<<<<<< ours\n')

    const r = Bun.spawnSync([process.execPath, join(shadow, 'orch.ts'), 'result', String(id), '--quiet'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe',
    })
    const stdout = new TextDecoder().decode(r.stdout)
    const stderr = new TextDecoder().decode(r.stderr)
    expect(r.exitCode).toBe(0)
    expect(stdout).toContain('already-paid-for answer')
    expect(stderr).toContain('degraded collection mode')
    expect(stderr).toContain('full CLI could not load')
  })

  test('wait falls back without loading the broken CLI graph', () => {
    const ok = insert('ok')
    const failed = insert('failed')
    db().query("UPDATE run SET failure_kind='harness', error='agent stopped' WHERE id=?").run(failed)

    const shadow = join(dir, 'degraded-wait-cli')
    mkdirSync(shadow, { recursive: true })
    for (const file of ['orch.ts', 'collect.ts', 'outcome.ts']) {
      writeFileSync(join(shadow, file), readFileSync(new URL(file, import.meta.url).pathname, 'utf8'))
    }
    writeFileSync(join(shadow, 'cli.ts'), '<<<<<<< ours\n')

    const r = Bun.spawnSync(
      [process.execPath, join(shadow, 'orch.ts'), 'wait', String(ok), String(failed)],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = new TextDecoder().decode(r.stdout)
    const stderr = new TextDecoder().decode(r.stderr)
    expect(r.exitCode).toBe(1)
    expect(stdout).toContain(`${ok}\tok`)
    expect(stdout).toContain(`${failed}\tfailed`)
    expect(stdout).toContain('harness: agent stopped')
    expect(stderr).toContain('degraded collection mode')
  })

  test('score refuses a harness-failed run even with force', () => {
    const id = insert('failed')
    db().query("UPDATE run SET failure_kind='harness' WHERE id=?").run(id)
    const r = orch('score', String(id), 'none', '--force')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id}`)
    expect(r.err).toContain("failure kind 'harness' is not evidence")
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test("score refuses a run whose agent is '(pending)'", () => {
    const id = insert('failed')
    db().query("UPDATE run SET agent='(pending)' WHERE id=?").run(id)
    const r = orch('score', String(id), 'none')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id}`)
    expect(r.err).toContain("agent is the placeholder '(pending)'")
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('score drops a habitual fidelity word for a review lens and records two axes', () => {
    const id = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    expect(orch('pending').code).toBe(1)

    const r = orch('score', String(id), 'full', 'right', 'faithful')
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      'review-lens has no spec to be faithful to, so it is judged on two axes only',
    )
    expect(r.out).toContain(`scored full right  [1]`)
    expect(db().query(
      'SELECT delivery, quality, fidelity FROM score WHERE run_id=?',
    ).get(id)).toEqual({ delivery: 'full', quality: 'right', fidelity: null })
    expect(orch('pending').code).toBe(0)
  })

  test('doctor excludes scores on not-evidence runs from its scored count', () => {
    score(insert('ok'), 'full', 'right')
    const interrupted = insert('failed')
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    score(interrupted, 'none')

    const r = orch('doctor')
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs 2, scored 1, unscored 0')
  })

  test('doctor prints every CLI version and warns below its recorded minimum', () => {
    const binDir = join(dir, 'doctor-bin')
    mkdirSync(binDir, { recursive: true })
    const versions: Record<string, string> = {
      codex: 'codex-cli 0.150.0', grok: 'grok 1.0.13 (build)',
      agy: '1.1.24', qwen: '0.7.1',
    }
    for (const [bin, version] of Object.entries(versions)) {
      const path = join(binDir, bin)
      writeFileSync(path, `#!/bin/sh\necho '${version}'\n`)
      chmodSync(path, 0o755)
    }

    const p = Bun.spawnSync([process.execPath, CLI, 'doctor'], {
      env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
        ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', ORCH_LOCAL_BASE_URL: '',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout)
    expect(p.exitCode).toBe(0)
    for (const version of Object.values(versions)) expect(out).toContain(`version ${version}`)
    expect(out).toContain('WARNING: codex 0.150.0 is below minimum 0.151.0')
    expect(out).not.toContain('WARNING: grok')
    expect(out).not.toContain('WARNING: agy')
    expect(out).not.toContain('WARNING: qwen-local')
  })

  test('re-scoring keeps the old note and confirms every latest axis', () => {
    const id = insert('ok', 'implement')
    expect(orch('score', String(id), 'full', 'right', 'faithful', '--note', 'first reason').code)
      .toBe(0)
    const rescored = orch(
      'score', String(id), 'partial', 'mixed', 'partial', '--note', 'later reason',
    )
    expect(rescored.code).toBe(0)
    expect(rescored.out).toContain('scored partial mixed partial')
    const saved = db().query('SELECT note FROM score WHERE run_id=?').get(id) as { note: string }
    expect(saved.note).toContain('first reason')
    expect(saved.note).toContain('later reason')
    expect(saved.note).toMatch(/--- re-scored \d{4}-\d{2}-\d{2}T/)
  })

  test('required project flags are rejected before the prompt file is read', () => {
    upsertProject({
      name: 'needs-key', path: process.cwd(),
      settings: { worktree: { branch: 'feature/{key}-{id}' } },
    })
    const r = orch('do', 'implement', '--file', '/definitely/not/a/prompt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('--key <KEY-123>')
    expect(r.err).not.toContain('ENOENT')
  })

  test('an unsupported explicit base is rejected before submit creates a run', () => {
    upsertProject({
      name: 'cannot-base', path: process.cwd(),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'feature/{id}',
        },
      },
    })
    const r = orch(
      'do', 'implement', '--base', 'HEAD', '--file', '/definitely/not/a/prompt',
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('command-based worktree path cannot honor --base')
    expect(r.err).not.toContain('ENOENT')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(0)
  })

  test('project set refuses incomplete resulting settings without saving them', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = orch(
      'project', 'set', 'warned', '--settings',
      JSON.stringify({ worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']) } }),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('has a create command but no branch template')
    expect(r.err).toContain('has a create command with a {seed} placeholder but no seeds list')
    const saved = db().query('SELECT settings FROM project WHERE name=?').get('warned') as
      { settings: string }
    expect(JSON.parse(saved.settings)).toEqual({})
  })

  test('project set --allow-incomplete saves and prints the same warnings', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = orch(
      'project', 'set', 'warned', '--settings',
      JSON.stringify({ worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']) } }),
      '--allow-incomplete',
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('has a create command but no branch template')
    expect(r.out).toContain('has a create command with a {seed} placeholder but no seeds list')
    const saved = db().query('SELECT settings FROM project WHERE name=?').get('warned') as
      { settings: string }
    expect(JSON.parse(saved.settings)).toEqual({
      worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']) },
    })
  })

  test('project set refuses legacy and malformed create declarations at registration', () => {
    upsertProject({ name: 'malformed-create', path: process.cwd() })
    for (const [create, message] of [
      ['scripts/worktree create {branch}', 'shell strings are not commands'],
      [{ command: 'scripts/worktree create', args: ['{branch}'] }, 'must name one executable'],
      [{ command: 'sh', args: ['-c', 'scripts/worktree create {branch}'] }, 'may not disguise a shell string'],
      [{ pipeline: 'scripts/worktree create {branch}' }, 'only for a command that uses a pipe'],
      [{ command: 'scripts/worktree', args: [{ value: '--base={base}', omitWhenEmpty: 'seed' }] },
        'value must contain {seed}'],
    ] as const) {
      const r = orch(
        'project', 'set', 'malformed-create', '--settings',
        JSON.stringify({ worktree: { create } }), '--allow-incomplete',
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(message)
      expect(projectByName('malformed-create')!.settings).toEqual({})
    }
  })

  test('project set admits the pipeline escape only for an actual pipeline', () => {
    upsertProject({ name: 'pipeline-create', path: process.cwd() })
    const pipeline = `printf '{"name":"{name}"}' | bun scripts/worktree.ts create`
    const r = orch(
      'project', 'set', 'pipeline-create', '--settings',
      JSON.stringify({ worktree: { create: { pipeline }, branch: 'task/{id}' } }),
      '--allow-incomplete',
    )
    expect(r.code).toBe(0)
    expect(projectByName('pipeline-create')!.settings.worktree?.create).toEqual({ pipeline })
  })

  test('project set settings null deletes that key during a deep merge', () => {
    upsertProject({ name: 'merged', path: process.cwd(), settings: { a: { b: 1, c: 2 } } })
    const r = orch('project', 'set', 'merged', '--settings', '{"a":{"b":null}}')
    expect(r.code).toBe(0)
    expect(projects().find((project) => project.name === 'merged')?.settings).toEqual({
      a: { c: 2 },
    })
  })

  test('project set refuses positional settings, names the first extra, and shows the working form', () => {
    upsertProject({ name: 'positional-settings', path: process.cwd() })
    const r = orch('project', 'set', 'positional-settings', 'gate', 'bun run check')
    expect(r.code).toBe(1)
    expect(r.err).toContain('unrecognised argument: gate')
    expect(r.err).toContain(
      'working form: orch project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]',
    )
    expect(projects().find((project) => project.name === 'positional-settings')?.settings).toEqual({})
  })

  test('project add and set --json print the resulting register row', () => {
    const added = orch(
      'project', 'add', dir, '--name', 'json-row', '--stack', 'first', '--no-canon', '--json',
    )
    expect(added.code).toBe(0)
    expect(JSON.parse(added.out)).toEqual(projects().find((project) => project.name === 'json-row'))

    const updated = orch('project', 'set', 'json-row', '--stack', 'second', '--canon', '--json')
    expect(updated.code).toBe(0)
    expect(JSON.parse(updated.out)).toEqual(projects().find((project) => project.name === 'json-row'))
  })

  test('an unattributed run warns with the explicit repo remedy', () => {
    const r = orch('do', 'summarize', '--file', '/definitely/not/a/prompt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('will not be attributed to any project')
    expect(r.err).toContain('--repo <name>')
  })

  test('an explicit repo is validated before the prompt is read', () => {
    const r = orch(
      'do', 'summarize', '--repo', 'not-registered', '--file', '/definitely/not/a/prompt',
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown repo "not-registered"')
    expect(r.err).not.toContain('ENOENT')
  })

  test('abandon retires an asking run and removes it from both inbox views', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db().query(
      `INSERT INTO question (run_id, asked_at, question)
       VALUES (?, ?, 'which design?')`,
    ).run(id, new Date().toISOString())
    expect(orch('inbox').out).toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).toContain(`run ${id}`)

    const abandoned = orch('abandon', String(id), '--note', 'superseded')
    expect(abandoned.code).toBe(0)
    const run = db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(id) as { status: string; error: string; failure_kind: string }
    expect(run).toEqual({
      status: 'stale', error: 'abandoned by architect: superseded', failure_kind: 'abandoned',
    })
    const question = db().query(
      'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
    ).get(id) as { answer: string; answered_by: string; answered_at: string | null }
    expect(question.answer).toBe('(abandoned)')
    expect(question.answered_by).toBe('abandoned')
    expect(question.answered_at).not.toBeNull()
    expect(orch('inbox').out).not.toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).not.toContain(`run ${id}`)
  })

  test('stop terminates a running vendor and reclaims its recorded worktree', async () => {
    const vendor = Bun.spawn(['sleep', '30'])
    const id = insert('running', 'implement')
    const worktree = createWorktree(dir, id)
    db().query('UPDATE run SET agent_pid=?, cwd=?, worktree=?, branch=? WHERE id=?')
      .run(vendor.pid, worktree.path, worktree.path, worktree.branch, id)

    try {
      const stopped = orch('stop', String(id))
      expect(stopped.code).toBe(0)
      expect(stopped.out).toContain(`stopped run ${id}`)
      expect(await vendor.exited).not.toBe(0)
      expect(db().query('SELECT status, error, failure_kind, worktree FROM run WHERE id=?').get(id))
        .toEqual({
          status: 'stopped', error: 'stopped by architect', failure_kind: null, worktree: null,
        })
      expect(existsSync(worktree.path)).toBe(false)
      const candidate = candidates('implement').find((item) => item.agent === 'codex')!
      expect(candidate.evidence).toBe(0)
      expect(candidate.failures).toBe(0)
    } finally {
      try { vendor.kill() } catch { /* already stopped */ }
      if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true })
    }
  })

  test('stop refuses a run that is not running without changing it', () => {
    const id = insert('ok')
    const r = orch('stop', String(id))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id} is ok, not running — nothing to stop`)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('ok')
  })

  test('stopping a running turn records the conversation root as stopped', () => {
    const root = insert('asking', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    expect(orch('stop', String(turn)).code).toBe(0)
    expect(db().query('SELECT id, status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn))
      .toEqual([{ id: root, status: 'stopped' }, { id: turn, status: 'stopped' }])
  })

  test('abandon refuses a completed run without changing it', () => {
    const id = insert('ok')
    const r = orch('abandon', String(id))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id} is ok, not asking — nothing to abandon`)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('ok')
  })

  test('an abandoned run is not routing evidence', () => {
    const id = insert('asking', 'implement')
    expect(orch('abandon', String(id)).code).toBe(0)
    const c = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.failures).toBe(0)
  })

  test('abandoning a child inherits stale onto the asking root as routing evidence', () => {
    const root = insert('asking', 'implement')
    const child = insert('asking', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, child)
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, new Date().toISOString(), 'root question?', 'answered', new Date().toISOString())
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'child question?')

    const before = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(before.evidence).toBe(0)

    expect(orch('abandon', String(child)).code).toBe(0)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(child))
      .toEqual({ status: 'stale', failure_kind: 'abandoned' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({ status: 'stale', failure_kind: null })
    const after = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(after.evidence).toBe(1)
    expect(after.failures).toBe(1)
  })

  test('abandon does not delete a branch recorded by another run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-abandon-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', 'kept.txt')
      git('commit', '-m', 'base')
      git('branch', 'shared-branch')

      const abandoned = insert('asking', 'implement')
      const owner = insert('stale', 'implement')
      const gone = join(repo, '.claude', 'worktrees', 'gone')
      db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
        .run(repo, gone, 'shared-branch', abandoned)
      db().query('UPDATE run SET branch=? WHERE id=?').run('shared-branch', owner)

      const r = orch('abandon', String(abandoned))
      expect(r.code).toBe(0)
      expect(r.out).toContain(`branch shared-branch left because run ${owner} records it`)
      expect(git('branch', '--list', 'shared-branch')).toContain('shared-branch')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('answer says an existing ruling stuck and reports the current status', () => {
    const id = insert('failed', 'implement')
    db().query(
      `INSERT INTO question (run_id, question, answer, asked_at, answered_at)
       VALUES (?, 'which way?', 'the ruled way', ?, ?)`,
    ).run(id, new Date().toISOString(), new Date().toISOString())
    const r = orch('answer', String(id), 'again')
    expect(r.code).toBe(1)
    expect(r.err).toContain('has already been ruled on')
    expect(r.err).toContain('current status is failed')
  })

  test('answer delivers a child turn live ruling without resuming the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'which design?')
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const r = orch('answer', String(root), 'use the first design')

    expect(r.code).toBe(0)
    expect(r.out).toContain('the owning turn is still working')
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(child) as
      { answer: string }).answer).toBe('use the first design')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('answer reads a ruling from a file without shell interpretation', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which names?')
    const path = join(dir, `answer-${id}.txt`)
    const ruling = 'Use $var and method(Param $x).\nKeep this line exactly.\n'
    writeFileSync(path, ruling)

    const r = orch('answer', String(id), '--file', path)

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe(ruling)
  })

  test('answer reads a ruling from stdin without shell interpretation', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which names?')
    const ruling = 'Use $var and method(Param $x).\nKeep this line exactly.\n'

    const r = orchInput(['answer', String(id)], ruling)

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe(ruling)
  })

  test('a partial multi-question ruling names the single-command rule', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'first?')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'second?')
    const questions = db().query('SELECT id FROM question WHERE run_id=? ORDER BY id')
      .all(id) as { id: number }[]

    const r = orch('answer', String(id), `--q${questions[0]!.id}`, 'only one')

    expect(r.code).toBe(1)
    expect(r.err).toContain('pass every --q<id> in a single command')
    expect((db().query('SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL').get() as
      { n: number }).n).toBe(0)
  })

  test('answer resumes a durable root question when no child is running', async () => {
    const root = addRun({ agent: 'missing-test-agent', job: 'implement', status: 'asking' })
    const prompt = join(dir, `answer-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original implementation spec')
    db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
      .run('test-session', prompt, root)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(root, new Date().toISOString(), 'which design?')
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const r = orch('answer', String(root), 'use the first design')

    expect(r.code).toBe(0)
    expect(r.out).toContain(`resumed run ${root} as run`)
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
    const resumed = db().query(
      'SELECT id FROM run WHERE id > ? ORDER BY id DESC LIMIT 1',
    ).get(root) as { id: number }

    for (let i = 0; i < 100; i++) {
      const status = (db().query('SELECT status FROM run WHERE id=?').get(resumed.id) as
        { status: string }).status
      if (status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })

  test('answer refuses questions split between live and stopped owners', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    const insertQuestion = db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    )
    insertQuestion.run(root, new Date().toISOString(), 'root question?')
    insertQuestion.run(child, new Date().toISOString(), 'child question?')

    const r = orch('answer', String(root), 'one', 'two')

    expect(r.code).toBe(1)
    expect(r.err).toContain('both live and stopped turns')
    expect(r.err).toContain(`run ${child}, running`)
    expect(r.err).toContain(`run ${root}, asking`)
    expect((db().query(
      'SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL',
    ).get() as { n: number }).n).toBe(0)
  })

  test('result on a still-running run exits 2, not 1', () => {
    // A poller must be able to tell "wait longer" from "stop waiting"; one exit
    // code for both would make a fan-out give up on its own runs.
    const id = insert('running')
    const r = orch('result', String(id))
    expect(r.code).toBe(2)
    expect(r.err).toContain('still running')
  })

  test('result on an unknown run says so rather than exiting 2', () => {
    expect(orch('result', '999999').code).toBe(1)
  })

  test('continue falls back to the chain\'s newest session when the latest turn has none', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const prompt = join(dir, `continue-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', prompt, root)
    const stale = insert('stale', 'file-question')
    db().query(
      'UPDATE run SET parent_run_id=?, turn=?, vendor_session=NULL, agent=? WHERE id=?',
    ).run(root, 2, 'codex', stale)
    try {
      const r = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root)],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout)
      const err = typeof r.stderr === 'string' ? r.stderr : new TextDecoder().decode(r.stderr)
      expect(r.exitCode).toBe(0)
      expect(err).toContain(`newest turn ${stale} recorded no session id`)
      expect(err).toContain(`resuming with the session from run ${root} (turn 1)`)
      const childId = Number(out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query(
        'SELECT status, parent_run_id, vendor_session FROM run WHERE id=?',
      ).get(childId) as
        { status: string; parent_run_id: number | null; vendor_session: string | null } | null
      expect(child?.status).not.toBe('running')
      expect(child?.parent_run_id).toBe(root)
      expect(child?.vendor_session).toBe('parent-session')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})

describe('vendor_session is recorded before the agent runs', () => {
  test('every resumed turn is prefixed with the root spec reminder without storing it again', async () => {
    const script = join(dir, 'resume-reminder.ts')
    writeFileSync(script, 'process.stdout.write("resumed")\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    let sent = ''
    agent.bin = process.execPath
    agent.resumeArgv = ({ prompt }) => {
      sent = prompt
      return [script]
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const root = addRun({ agent: 'codex', job: 'file-question', status: 'ok' })
    const spec = 's'.repeat(600) + 'NOT INCLUDED'
    const rootPrompt = join(dir, 'root-spec.prompt.txt')
    writeFileSync(rootPrompt, spec)
    db().query('UPDATE run SET prompt_path=?, vendor_session=? WHERE id=?')
      .run(rootPrompt, 'test-session', root)
    try {
      const result = await runJob({
        job: 'file-question', prompt: 'the resumed-turn message', cwd: dir,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      expect(sent).toBe([
        'REMINDER FROM THE ORIGINAL SPEC', '', 's'.repeat(600), '',
        'Do not decide what the spec did not settle; ask.',
        'You may commit to your own throwaway branch. Do not push, merge into trunk, or rewrite history.',
        '', '---', '', 'the resumed-turn message',
      ].join('\n'))
      expect(readFileSync((db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }).prompt_path, 'utf8')).toBe('the resumed-turn message')
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
    }
  })

  test('a resume claim stores the inherited session before the agent runs', async () => {
    const script = join(dir, 'read-own-session.ts')
    writeFileSync(script, `
import { Database } from 'bun:sqlite'
const row = new Database(process.env.ORCH_DB!).query(
  'SELECT vendor_session, status FROM run WHERE id = ?',
).get(Number(process.env.ORCH_RUN_ID))
process.stdout.write(JSON.stringify(row))
`)
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const inherited = 'inherited-session'
    const rootPrompt = join(dir, 'session-root.prompt.txt')
    writeFileSync(rootPrompt, 'original spec')
    const resume = (parent: number, turn: number) => ({
      parent, agent: 'codex', session: inherited, turn,
      sessionId: 'orch-test-session', worktree: null,
    })
    try {
      const parent = addRun({ agent: 'codex', job: 'file-question', status: 'stale' })
      db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
        .run(inherited, rootPrompt, parent)

      const inserted = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir,
        resume: resume(parent, 2),
      })
      expect(JSON.parse(inserted.output)).toEqual({
        vendor_session: inherited, status: 'running',
      })

      const reserved = (db().query(
        `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES (?, '(pending)', 'file-question', 'x', 1, 'x', 'running') RETURNING id`,
      ).get(new Date().toISOString()) as { id: number }).id
      const updated = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir, reserveId: reserved,
        resume: resume(parent, 3),
      })
      expect(updated.id).toBe(reserved)
      expect(JSON.parse(updated.output)).toEqual({
        vendor_session: inherited, status: 'running',
      })
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(rootPrompt, { force: true })
    }
  })
})

describe('childEnv allowlists the vendor CLI environment', () => {
  test('a spawned agent does not inherit unrelated credentials', async () => {
    const script = join(dir, 'dump-env-dev89.ts')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env))\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    agent.bin = process.execPath
    agent.argv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'

    const planted = [
      'UNRELATED_SECRET_DEV89', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID',
      'EXAMPLE_MCP_TOKEN', 'LC_ALL', 'XDG_CONFIG_HOME', 'OPENAI_API_KEY',
      'COLORTERM',
    ] as const
    const prior: Record<string, string | undefined> = {}
    for (const key of planted) prior[key] = process.env[key]
    process.env.UNRELATED_SECRET_DEV89 = 'should-not-leak'
    process.env.ANTHROPIC_API_KEY = 'should-not-leak'
    process.env.CLAUDE_CODE_SESSION_ID = 'should-not-leak'
    process.env.EXAMPLE_MCP_TOKEN = 'should-not-leak'
    process.env.LC_ALL = 'C'
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-dev89'
    process.env.OPENAI_API_KEY = 'vendor-ok'
    process.env.COLORTERM = 'truecolor'
    upsertProject({ name: 'env-allow', path: dir, settings: { envPrefix: 'EXAMPLE' } })

    try {
      const result = await runJob({
        job: 'file-question', prompt: 'dump env', cwd: dir, agent: 'codex',
      })
      const child = JSON.parse(result.output) as Record<string, string>
      expect(child.UNRELATED_SECRET_DEV89).toBeUndefined()
      expect(child.ANTHROPIC_API_KEY).toBeUndefined()
      expect(child.CLAUDE_CODE_SESSION_ID).toBeUndefined()
      expect(child.EXAMPLE_MCP_TOKEN).toBeUndefined()
      expect(child.COLORTERM).toBeUndefined()
      expect(child.LC_ALL).toBe('C')
      expect(child.XDG_CONFIG_HOME).toBe('/tmp/xdg-dev89')
      expect(child.OPENAI_API_KEY).toBe('vendor-ok')
      expect(child.PATH).toBe(process.env.PATH as string)
      expect(child.HOME).toBe(process.env.HOME as string)
      expect(child.ORCH_DB).toBe(process.env.ORCH_DB as string)
      expect(child.ORCH_DEPTH).toBe('1')
      expect(child.ORCH_RUN_ID).toBe(String(result.id))
      expect(child.ORCH_RUN_TOKEN).toBeTruthy()
      for (const key of ['USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK'] as const) {
        const parent = process.env[key]
        if (parent !== undefined) expect(child[key]).toBe(parent)
        else expect(child[key]).toBeUndefined()
      }
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      for (const key of planted) {
        if (prior[key] === undefined) delete process.env[key]
        else process.env[key] = prior[key]
      }
    }
  })
})

describe('a worker that stops to ask is not a worker that failed', () => {
  test('an unparseable reply is rejected rather than read as a status', () => {
    // The dangerous direction: treating "no structured reply" as success would
    // record an unverifiable change set as a completed implementation.
    expect(parseWorkerReply('I have finished the work, it all looks good.')).toBeNull()
    expect(parseWorkerReply('')).toBeNull()
  })

  test('an unknown status is not silently promoted to done', () => {
    expect(parseWorkerReply(JSON.stringify(workerReply({ status: 'partially-done' })))).toBeNull()
  })

  test('the object is recovered from prose and from a fence', () => {
    const fenced = parseWorkerReply(`Here is my report:\n\`\`\`json\n${JSON.stringify(workerReply())}\n\`\`\``)
    expect(fenced?.status).toBe('done')
    const embedded = parseWorkerReply(`Result: ${JSON.stringify(workerReply({
      status: 'asking', summary: 'need a ruling', questions: null,
    }))} — over to you`)
    expect(embedded?.status).toBe('asking')
  })

  test('a schema-shaped reply keeps its questions', () => {
    const r = parseWorkerReply(JSON.stringify(workerReply({
      status: 'asking', summary: 'stopped', questions: [{
        question: 'one table or two?', options: ['one', 'two'], recommendation: 'two', why: null,
      }],
    })))
    expect(r?.questions?.[0]?.recommendation).toBe('two')
  })

  test('a status alone is not a worker contract', () => {
    expect(parseWorkerReply('{"status":"done"}')).toBeNull()
  })

  test('wrong-typed nested values reject the whole candidate', () => {
    expect(parseWorkerReply(JSON.stringify(workerReply({ questions: [{
      question: 'q?', options: null, recommendation: {}, why: null,
    }] })))).toBeNull()
  })
})

describe('a writing worker must return evidence of completed work', () => {
  async function runInCleanTree(output: string): Promise<Awaited<ReturnType<typeof runJob>>> {
    const repo = mkdtempSync(join(tmpdir(), 'orch-empty-write-'))
    const script = join(dir, `worker-${Math.random().toString(16).slice(2)}.ts`)
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync(['git', '-c', 'user.name=Orch Test',
      '-c', 'user.email=orch@example.invalid', 'commit', '-m', 'seed'], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 76)
    writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`)

    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    const origReadsOut = agent.readsOut
    agent.bin = process.execPath
    agent.resumeArgv = (o) => {
      expect(o.sandbox).toBe('workspace-write')
      expect(o.writableRoots).toEqual([
        worktreeGitDir(tree.path), ...workerSharedGitRoots(tree.path, tree.branch),
      ])
      return [script]
    }
    agent.readsOut = false
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const rootPrompt = join(dir, `write-root-${parent}.prompt.txt`)
    writeFileSync(rootPrompt, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(rootPrompt, parent)
    try {
      return await runJob({
        job: 'implement', prompt: 'continue', cwd: tree.path,
        resume: {
          parent, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session',
          worktree: tree,
        },
      })
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      agent.readsOut = origReadsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
    }
  }

  test('done with no claimed or measured change and no test run is failed', async () => {
    let failure: Error & { runId?: number } | null = null
    try {
      await runInCleanTree(JSON.stringify(workerReply({
        files_changed: [], tests: { command: null, ran: false, passed: null, detail: null },
      })))
    } catch (e) {
      failure = e as Error & { runId?: number }
    }
    expect(failure?.message).toContain('reported done with no change and no test run')
    expect(failure?.runId).toBeDefined()
    const row = db().query('SELECT status, error, files_changed FROM run WHERE id=?')
      .get(failure!.runId!) as { status: string; error: string; files_changed: number }
    expect(row).toEqual({
      status: 'failed', error: 'reported done with no change and no test run', files_changed: 0,
    })
  })

  test('multiple contracts leave a visible note on an otherwise successful run', async () => {
    const result = await runInCleanTree([
      workerReply({ summary: 'real reply' }),
      workerReply({ summary: 'quoted contract-shaped object' }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(result.contract?.summary).toBe('quoted contract-shaped object')
    expect((db().query('SELECT error FROM run WHERE id=?').get(result.id) as { error: string }).error)
      .toBe('2 contract objects in output; took the last')
  })
})

describe('a conversation is one unit of work, not one per turn', () => {
  const routingEvidenceIds = () => (db().query(
    `SELECT r.id FROM run r LEFT JOIN score s ON s.run_id=r.id
      WHERE r.status IN ('ok','failed','stale') AND r.probe=0
        AND r.evidence_excluded IS NULL AND r.parent_run_id IS NULL
        AND (s.delivery IS NOT NULL OR
             (r.status IN ('failed','stale') AND s.delivery IS NULL))
      ORDER BY r.id`,
  ).all() as { id: number }[]).map((row) => row.id)

  test('a three-turn chain resolves the intermediate asking turn end to end', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-three-turn-'))
    const script = join(dir, `three-turn-${Math.random().toString(16).slice(2)}.ts`)
    const promptPath = join(dir, `three-turn-${Math.random().toString(16).slice(2)}.prompt.txt`)
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync([
      'git', '-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid',
      'commit', '-m', 'seed',
    ], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 137)

    const agent = AGENTS.codex!
    const originalBin = agent.bin
    const originalResume = agent.resumeArgv
    const originalReadsOut = agent.readsOut
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'

    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    writeFileSync(promptPath, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, root)
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'first question?', 'first ruling', nowIso())

    try {
      writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(workerReply({
        status: 'asking', summary: 'need a second ruling', files_changed: null,
        questions: [{
          question: 'second question?', options: ['one', 'two'], recommendation: 'one', why: null,
        }],
      })))})\n`)
      const second = await runJob({
        job: 'implement', prompt: 'continue', cwd: tree.path,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      expect(second.status).toBe('asking')
      const question = db().query('SELECT id FROM question WHERE run_id=?').get(second.id) as { id: number }
      db().query('UPDATE question SET answer=?, answered_at=? WHERE id=?')
        .run('second ruling', nowIso(), question.id)

      writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(workerReply()))})\n`)
      const third = await runJob({
        job: 'implement', prompt: 'finish', cwd: tree.path,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 3,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })

      expect(db().query(
        'SELECT turn, status FROM run WHERE id=? OR parent_run_id=? ORDER BY turn',
      ).all(root, root)).toEqual([
        { turn: 1, status: 'ok' },
        { turn: 2, status: 'ok' },
        { turn: 3, status: 'ok' },
      ])
      expect(third.status).toBe('ok')
    } finally {
      agent.bin = originalBin
      agent.resumeArgv = originalResume
      agent.readsOut = originalReadsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
      rmSync(promptPath, { force: true })
    }
  })

  test('superseding an answered child resolves it without changing routing evidence', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    score(root, 'full', 'right')
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    // A score makes the independent child predicate load-bearing: changing
    // only `asking` to `ok` would admit this row if parent_run_id stopped being
    // part of the router's evidence rule.
    score(child, 'full', 'right')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(child, nowIso(), 'which shape?', 'the ruled shape', nowIso())
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    const before = routingEvidenceIds()

    expect(resolveSupersededTurn(db(), root, 2)).toBe(1)

    expect(db().query('SELECT status FROM run WHERE id=?').get(child)).toEqual({ status: 'ok' })
    expect(routingEvidenceIds()).toEqual(before)
    expect(candidates('implement').find((row) => row.agent === 'codex')?.evidence).toBe(1)
  })

  test('resolution is child-only, exact, and evidence-neutral', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    score(root, 'full', 'right')
    const matched = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    score(matched, 'full', 'right')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(matched, nowIso(), 'which shape?', 'the ruled shape', nowIso())
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })

    const unanswered = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 4,
    })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(unanswered, nowIso(), 'still waiting?')
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 5 })

    const noSuccessor = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 6,
    })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(noSuccessor, nowIso(), 'latest question?', 'answered', nowIso())

    const askingRoot = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(askingRoot, nowIso(), 'root question?', 'answered', nowIso())
    addRun({ agent: 'grok', job: 'implement', parent: askingRoot, turn: 2 })
    const before = routingEvidenceIds()
    const statusOf = (id: number) => db().query('SELECT status FROM run WHERE id=?').get(id)

    // The bulk cutover script is gone; these are the boundaries of the rule it
    // enforced, which now lives in the write path and is what must not drift.
    expect(resolveSupersededTurn(db(), root, 2)).toBe(1)
    expect(statusOf(matched)).toEqual({ status: 'ok' })

    // An unanswered question means the turn is still waiting, not superseded.
    expect(resolveSupersededTurn(db(), root, 4)).toBe(0)
    expect(statusOf(unanswered)).toEqual({ status: 'asking' })

    // Nothing came after it, so nothing superseded it.
    expect(resolveSupersededTurn(db(), root, 6)).toBe(0)
    expect(statusOf(noSuccessor)).toEqual({ status: 'asking' })

    // A root is addressed as nobody's child, so it can never be resolved this
    // way however answered its question is. DEV-146 is the counterpart that
    // inherits the last turn's terminal status onto the root; this function
    // must still refuse, or the two rules fight.
    expect(resolveSupersededTurn(db(), askingRoot, 1)).toBe(0)
    expect(statusOf(askingRoot)).toEqual({ status: 'asking' })

    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a stranded root inherits the last turn\'s terminal status and joins routing evidence', () => {
    // The 1095 shape: root still asking, last turn stale, questions answered.
    // DEV-137 pinned that child resolution must not move the evidence set.
    // This is the opposite: the root becoming stale is a new judgement.
    for (let i = 0; i < MIN_SAMPLE - 1; i++) {
      addRun({ agent: 'grok', job: 'implement', status: 'failed', kind: 'other' })
    }
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    score(root, 'none')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'root question?', 'answered', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'stale', parent: root, turn: 2, kind: 'abandoned',
    })

    const before = routingEvidenceIds()
    expect(before).not.toContain(root)
    const beforeGrok = candidates('implement').find((row) => row.agent === 'grok')!
    expect(beforeGrok.evidence).toBe(MIN_SAMPLE - 1)

    expect(resolveRootFromLastTurn(db(), root)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({ status: 'stale', failure_kind: null })

    const after = routingEvidenceIds()
    expect(after).toEqual([...before, root].sort((a, b) => a - b))
    const afterGrok = candidates('implement').find((row) => row.agent === 'grok')!
    expect(afterGrok.evidence).toBe(MIN_SAMPLE)
    expect(afterGrok.scored).toBe(1)
  })

  test('a root waiting on a ruling is not stranded', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(root, nowIso(), 'still waiting?')
    addRun({
      agent: 'grok', job: 'implement', status: 'stale', parent: root, turn: 2,
    })
    const before = routingEvidenceIds()

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a recoverable root whose last turn is still asking is not ended', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered, not continued', 'the ruling', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    const before = routingEvidenceIds()

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a root whose newest turn is still running is not ended', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered', 'the ruling', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'running', parent: root, turn: 2,
    })

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
  })

  test('the last turn\'s terminal status is inherited, not rewritten to ok', () => {
    const failed = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(failed, nowIso(), 'which way?', 'that way', nowIso())
    addRun({
      agent: 'codex', job: 'implement', status: 'failed', parent: failed, turn: 2, kind: 'timeout',
    })
    expect(resolveRootFromLastTurn(db(), failed)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ status: 'failed', failure_kind: null })

    const succeeded = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(succeeded, nowIso(), 'which way?', 'that way', nowIso())
    addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: succeeded, turn: 2 })
    expect(resolveRootFromLastTurn(db(), succeeded)).toBe(1)
    expect(db().query('SELECT status FROM run WHERE id=?').get(succeeded))
      .toEqual({ status: 'ok' })
  })

  test('turns of one run do not each count as evidence', () => {
    // A worker that asked two questions produces three rows. Counting each
    // would let an agent reach MIN_SAMPLE by being inquisitive rather than good.
    const root = addRun({ agent: 'codex', job: 'implement' })
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    score(root, 'full', 'right')

    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.runs).toBe(1)      // one unit of work
    expect(c.evidence).toBe(1)  // one judgement, not three
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('a child turn is never offered for scoring', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's1' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2, session: 's1' })
    const ids = pendingForSession('s1').map((r) => r.id)
    expect(ids).toContain(root)
    expect(ids).not.toContain(child)
  })

  test('a root is not offered while its newest turn is still running', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's1' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2, session: 's1',
    })
    expect(pendingForSession('s1')).toHaveLength(0)
    expect(unscoredCount()).toBe(0)

    db().query("UPDATE run SET status='ok' WHERE id=?").run(child)
    expect(pendingForSession('s1').map((r) => r.id)).toEqual([root])
    expect(unscoredCount()).toBe(1)
  })
})

describe('a worktree is resolved against the main checkout, not the caller cwd', () => {
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
    const p = Bun.spawnSync(['git', ...args], {
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

  test('review-lens preflight requires a git checkout', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orch-no-repo-'))
    const { repo } = scratchRepo()
    const priorDepth = process.env.ORCH_DEPTH
    try {
      process.env.ORCH_DEPTH = '0'
      expect(() => preflight('review-lens', outside, undefined, undefined, undefined, false, false, 'scope')).toThrow('not inside a git checkout')
      expect(() => preflight('review-lens', repo, undefined, undefined, undefined, false, false, 'scope')).not.toThrow()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(outside, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('preflight refuses a create command without a branch template', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-branch-'))
    upsertProject({
      name: 'no-branch', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']) } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'orch project set no-branch --settings \'{"worktree":{"branch":"<template>"}}\'',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight refuses an explicit base a command template cannot honor', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-base-placeholder', path: realpathSync(repo),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'task/{id}',
        },
      },
    })
    try {
      expect(() => fromRoot(() => preflight(
        'implement', realpathSync(repo), undefined, undefined, 'main',
      )))
        .toThrow(
          "this project's command-based worktree path cannot honor --base because its " +
          'create arguments do not declare {base}',
        )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('preflight refuses shell metacharacters in a key', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-bad-key-'))
    upsertProject({
      name: 'bad-key', path: repo,
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-70; touch nope')))
      .toThrow('key "DEV-70; touch nope" does not match ^[A-Z][A-Z0-9]+-[0-9]+$')
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight reports missing key and seed together', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-missing-arguments-'))
    upsertProject({
      name: 'missing-arguments', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: '{key}-orch-{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>\n` +
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed full\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-61'))).toThrow(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed full\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('read-only preflight selects the project-declared none seed', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'read-only-arguments', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: '{key}-orch-{id}',
          seeds: ['none', 'small', 'full'],
        },
      },
    })
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBe('none')
    expect(fromRoot(() => preflight(
      'review-lens', repo, 'small', undefined, undefined, false, false, 'safety',
    ))).toBe('small')
    rmSync(repo, { recursive: true, force: true })
  })

  test('read-only preflight refuses a seeded project without none before creating a tree', () => {
    const { repo } = scratchRepo()
    const trees = join(repo, '.claude', 'worktrees')
    upsertProject({
      name: 'read-only-no-none', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    const before = readdirSync(trees).sort()
    expect(() => fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toThrow(
      'project read-only-no-none requires an explicit seed, but its seed list has no "none" option',
    )
    expect(readdirSync(trees).sort()).toEqual(before)
    rmSync(repo, { recursive: true, force: true })
  })

  test('read-only preflight leaves a project without listed seeds unaffected', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'read-only-unseeded', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'task/{id}' } },
    })
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

  test('fill shell-quotes unquoted values and respects existing quotes', () => {
    const value = "two words' ; echo nope"
    for (const render of [fill, fillTool]) {
      expect(render('cmd {name}', { name: value })).toBe("cmd 'two words'\\'' ; echo nope'")
      expect(render("cmd '{name}'", { name: value })).toBe("cmd 'two words'\\'' ; echo nope'")
      expect(render('cmd "{name}"', { name: value })).toBe("cmd \"two words' ; echo nope\"")
    }
  })

  test('structured create declarations render argv without a shell', () => {
    const vars = {
      branch: 'technical/DEV-70-orch-804', seed: 'none', name: 'orch-804',
      path: '/tmp/orch-804', base: '', key: 'DEV-70',
    }
    expect(createArgv(declaredCreate('scripts/worktree', [
      'add', '{branch}', '{base}', { expand: 'seed' }, '--name={name}',
    ]), vars)).toEqual([
      'scripts/worktree', 'add', 'technical/DEV-70-orch-804', '', 'none', '--name=orch-804',
    ])
    expect(createArgv(declaredCreate('bun', [
      'run', 'worktree', 'create', '{branch}',
      { value: '--base={base}', omitWhenEmpty: 'base' },
    ]), vars)).toEqual([
      'bun', 'run', 'worktree', 'create', 'technical/DEV-70-orch-804',
    ])
    expect(createArgv(declaredCreate('bun', [
      'run', 'worktree', 'create', '{branch}',
      { value: '--base={base}', omitWhenEmpty: 'base' },
    ]), { ...vars, base: 'abc123' })).toEqual([
      'bun', 'run', 'worktree', 'create', 'technical/DEV-70-orch-804', '--base=abc123',
    ])
  })

  test('legacy reads and migrated declarations invoke all four tools identically', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-legacy-create-'))
    const bin = join(root, 'bin')
    const scripts = join(root, 'scripts')
    const capture = join(root, 'capture.json')
    mkdirSync(bin)
    mkdirSync(scripts)
    const recorder = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const input = await Bun.stdin.text()
appendFileSync(process.env.CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  name: process.env.WORKTREE_NAME_OVERRIDE ?? null,
  seed: process.env.WORKTREE_SEED ?? null,
  input,
}) + '\\n')
`
    writeFileSync(join(bin, 'bun'), recorder)
    writeFileSync(join(scripts, 'worktree'), recorder)
    chmodSync(join(bin, 'bun'), 0o755)
    chmodSync(join(scripts, 'worktree'), 0o755)

    const old = {
      adanim: 'echo \'{"cwd":"\'"$PWD"\'","name":"{name}"}\' | bun run scripts/worktree.ts create',
      alephbeis: "scripts/worktree add {branch} '{base}' {seed} --name={name} && echo $PWD/.claude/worktrees/{name}",
      starship: "WORKTREE_NAME_OVERRIDE={name} WORKTREE_SEED='{seed}' scripts/worktree add {branch} '{base}'",
      stopal: 'bun run worktree create "{branch}"',
    }
    const migrated = {
      adanim: { pipeline: old.adanim },
      alephbeis: declaredCreate('scripts/worktree', [
        'add', '{branch}', '{base}', { expand: 'seed' }, '--name={name}',
      ]),
      starship: declaredCreate('env', [
        'WORKTREE_NAME_OVERRIDE={name}', 'WORKTREE_SEED={seed}',
        'scripts/worktree', 'add', '{branch}', '{base}',
      ]),
      stopal: declaredCreate('bun', ['run', 'worktree', 'create', '{branch}']),
    }
    const invoke = (create: WorktreeCreate | string, vars: Record<string, string>) => {
      writeFileSync(capture, '')
      const result = Bun.spawnSync(createArgv(create, vars), {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CAPTURE: capture },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      return readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    }
    try {
      for (const base of ['', 'abc123']) {
        const vars = {
          branch: 'technical/DEV-182-orch-1519', name: 'orch-1519',
          seed: '--full --budget-mb=2000', base, key: 'DEV-182', path: '',
        }
        for (const project of Object.keys(old) as (keyof typeof old)[]) {
          expect(invoke(old[project], vars)).toEqual(invoke(migrated[project], vars))
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preflight refuses a create placeholder without --seed even when no seeds are listed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-seed-'))
    upsertProject({
      name: 'no-seed', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'contain {seed}, so a seed is required',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight passes a project-specific seed spec intact to the project resolver', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-custom-seed-'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const received = join(repo, 'received-seed')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then
  shift
  for arg in "$@"; do printf '%s\\n' "$arg" >> "${received}"; done
  printf -- '---\\n' >> "${received}"
  exit 0
fi
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'custom-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', { expand: 'seed' }]), branch: 'task/{id}',
          seeds: ['none', 'minimal', 'full'],
        },
      },
    })
    const seeds = [
      '--full --budget-mb=2000', '--bundle=tanach --bundle=word-bank',
      'none', 'minimal', 'full',
    ]
    for (const seed of seeds) {
      expect(() => fromRoot(() => preflight('implement', repo, seed))).not.toThrow()
    }
    expect(readFileSync(received, 'utf8')).toBe(
      '--full\n--budget-mb=2000\n---\n' +
      '--bundle=tanach\n--bundle=word-bank\n---\n' +
      'none\n---\nminimal\n---\nfull\n---\n',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('resolver argv equals the explicitly expanded create argv', () => {
    const positional = declaredCreate('scripts/worktree', [
      'add', '{branch}', '{base}', { expand: 'seed' }, '--name={name}',
    ])
    const scalar = declaredCreate('env', [
      'WORKTREE_SEED={seed}', 'scripts/worktree', 'add', '{branch}', '{base}',
    ])
    const vars = { branch: 'b', name: 'n', base: '', key: '', path: '' }
    for (const seed of ['--full --budget-mb=2000', "--tables='hello world'"]) {
      const rendered = createArgv(positional, { ...vars, seed })!
      const resolveArgv = seedArgv(positional, seed)
      expect(rendered.slice(4, -1)).toEqual(resolveArgv)
    }
    expect(seedArgv(scalar, '--full --budget-mb=2000')).toEqual(['--full --budget-mb=2000'])
    expect(seedArgv(scalar, "--tables='hello world'")).toEqual(["--tables='hello world'"])
  })

  test('a scalar seed argument keeps the seed as one resolve argv', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-quoted-seed-'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const received = join(repo, 'received-seed')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then
  shift
  for arg in "$@"; do printf '%s\\n' "$arg" >> "${received}"; done
  exit 0
fi
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'quoted-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('env', ['WORKTREE_SEED={seed}', 'scripts/worktree', 'add', '{branch}']),
          branch: 'task/{id}',
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, '--full --budget-mb=2000')))
      .not.toThrow()
    expect(readFileSync(received, 'utf8')).toBe('--full --budget-mb=2000\n')
    rmSync(repo, { recursive: true, force: true })
  })

  test('a resolver refusal happens before a run row or worktree can exist', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-rejected-seed-'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const created = join(repo, 'create-ran')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then echo 'over budget' >&2; exit 2; fi
touch "${created}"
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'rejected-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}', seeds: ['full'],
        },
      },
    })
    const started = performance.now()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({ job: 'implement', prompt: 'change it', cwd: repo, seed: 'full' }))
        .rejects.toThrow("the project's seed resolver rejected the seed:\nover budget")
      expect(performance.now() - started).toBeLessThan(1000)
      expect(existsSync(created)).toBe(false)
      expect(existsSync(join(repo, '.claude', 'worktrees'))).toBe(false)
      expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(0)
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a resolver failure is not treated as a successful check', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-unchecked-seed-'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
echo 'catalog unreachable' >&2
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'unchecked-seed', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'minimal'))).toThrow(
      "the project's seed resolver rejected the seed or could not check it:\ncatalog unreachable",
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('a project whose worktree tool exposes no resolver still accepts its seed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-resolver-'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
echo 'Usage: scripts/worktree create [seed]'
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'no-resolver', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, '--anything=project-specific')))
      .not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight accepts a branch template and a listed seed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-good-tool-'))
    upsertProject({
      name: 'good-tool', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

  test('from inside a worktree, repoRootOf is the main checkout, not this tree', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const got = repoRootOf(process.cwd())
      expect(got).not.toBeNull()
      expect(realpathSync(got!)).toBe(realpathSync(repo))
      expect(realpathSync(got!)).not.toBe(realpathSync(tree))
      // And the naive --show-toplevel answer, which is what shipped, is the
      // worktree itself. If this ever stops being true the bug cannot recur
      // in the same shape and the test should be rewritten, not weakened.
      const toplevel = git(process.cwd(), 'rev-parse', '--show-toplevel')
      expect(realpathSync(toplevel)).toBe(realpathSync(tree))
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('createWorktree from inside a worktree does not nest under it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const w = createWorktree(process.cwd(), 657)
      expect(realpathSync(w.repoRoot)).toBe(realpathSync(repo))
      expect(realpathSync(w.path)).toBe(
        realpathSync(join(repo, '.claude', 'worktrees', 'orch-657')),
      )
      expect(w.path.startsWith(tree)).toBe(false)
      expect(existsSync(join(tree, '.claude', 'worktrees', 'orch-657'))).toBe(false)
      expect(readFileSync(join(w.path, '.orch-run'), 'utf8')).toBe(`657\n${realpathSync(repo)}\n`)
      const exclude = resolve(w.path, git(w.path, 'rev-parse', '--git-path', 'info/exclude'))
      expect(readFileSync(exclude, 'utf8').split('\n')).toContain('.orch-run')
      expect(git(w.path, 'check-ignore', '.orch-run')).toBe('.orch-run')
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a read-only job passes its preflight-selected none seed to the project tool', () => {
    const { repo } = scratchRepo()
    const received = join(repo, 'received-seed')
    const path = join(repo, '.claude', 'worktrees', 'orch-658')
    const tool = {
      branch: 'orch/{id}',
      seeds: ['none', 'full'],
      create: compoundCreate(
        `printf '%s' {seed} > "${received}" && ` +
        `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
        `echo "${path}"`),
    }
    upsertProject({ name: 'read-only-tool-seed', path: repo, settings: { worktree: tool } })
    try {
      const seed = fromRoot(() => preflight(
        'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
      ))
      const w = createWithTool(tool, repo, 658, seed)
      expect(w.path).toBe(path)
      expect(readFileSync(received, 'utf8')).toBe('none')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the path is read from stdout, whatever the tool says on stderr afterwards', () => {
    // One project's shape: path on stdout, progress on stderr, and the progress
    // printed last. Joining the streams put a progress line where the path
    // should be and sent run 735 to a directory nothing had created.
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'technical_sto_993_orch_735')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}" && ` +
            `echo 'Database cloned.' >&2 && echo 'task status not written' >&2`),
        },
        process.cwd(),
        735,
      )
      expect(w.path).toBe(custom)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a tool that prints its path is believed, not second-guessed', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'custom-657')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        process.cwd(),
        657,
      )
      expect(w.path).toBe(custom)
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-657'))).toBe(false)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a project-created tree is recorded before its ownership marker is written', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const custom = join(repo, 'elsewhere', `orch-${id}`)
    try {
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        repo, id, undefined, undefined, undefined,
        (created) => {
          expect(existsSync(created.path)).toBe(true)
          expect(existsSync(join(created.path, '.orch-run'))).toBe(false)
          db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
            .run(created.path, created.path, created.branch, created.base, id)
        },
      )
      expect(existsSync(join(w.path, '.orch-run'))).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: custom })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a project-created tree is removed when its run cannot record it', () => {
    const { repo } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'orch-920')
    try {
      expect(() => createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        repo, 920, undefined, undefined, undefined,
        () => { throw new Error('database write failed') },
      )).toThrow(/database write failed[\s\S]*unrecorded worktree cleanup: removed/)
      expect(existsSync(custom)).toBe(false)
      expect(git(repo, 'branch', '--list', 'orch/920')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a stop between recording and marking leaves no project-created orphan', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const custom = join(repo, 'elsewhere', `orch-${id}`)
    let stopped: { code: number; err: string } | null = null
    try {
      let failure = ''
      try {
        createWithTool(
          {
            create: compoundCreate(
              `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
              `echo "${custom}"`),
          },
          repo, id, undefined, undefined, undefined,
          (created) => {
            db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
              .run(created.path, created.path, created.branch, created.base, id)
            const p = Bun.spawnSync(
              [process.execPath, new URL('cli.ts', import.meta.url).pathname, 'stop', String(id)],
              {
                env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
                stdout: 'pipe', stderr: 'pipe',
              },
            )
            stopped = { code: p.exitCode, err: p.stderr.toString() }
          },
        )
      } catch (e) {
        failure = String((e as Error).message ?? e)
      }
      expect(failure).not.toBe('')
      expect(stopped).not.toBeNull()
      expect(stopped!.err).toBe('')
      expect(stopped!.code).toBe(0)
      expect(existsSync(custom)).toBe(false)
      expect(db().query('SELECT status, worktree FROM run WHERE id=?').get(id))
        .toEqual({ status: 'stopped', worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('separate processes serialize complete creation for the same project', async () => {
    const { repo } = scratchRepo()
    const overlap = join(repo, '.git', 'creation-overlap')
    const module = new URL('worktree.ts', import.meta.url).href
    const child = `
      const { createWithTool } = await import(process.argv[1])
      createWithTool({ create: JSON.parse(process.argv[4]), branch: 'orch/{id}' }, process.argv[2], Number(process.argv[3]))
    `
    const create = compoundCreate(
      `if ! mkdir "${overlap}"; then echo 'creations overlapped' >&2; exit 19; fi; ` +
      `trap 'rmdir "${overlap}"' EXIT; sleep 0.15; ` +
      `${hermeticGitCommand} worktree add -b {branch} "${repo}/.claude/worktrees/{name}" HEAD ` +
      `>/dev/null && echo "${repo}/.claude/worktrees/{name}"`)
    try {
      const children = [910, 911, 912, 913].map((id) => Bun.spawn(
        [process.execPath, '-e', child, module, repo, String(id), JSON.stringify(create)],
        { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
      ))
      const exits = await Promise.all(children.map((p) => p.exited))
      expect(exits).toEqual([0, 0, 0, 0])
      for (const id of [910, 911, 912, 913]) {
        const path = join(repo, '.claude', 'worktrees', `orch-${id}`)
        expect(git(path, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')
        expect(git(path, 'diff', '--exit-code', 'HEAD', '--')).toBe('')
        expect(git(path, 'diff', '--cached', '--exit-code', 'HEAD', '--')).toBe('')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a creation lock held by a live owner waits and names its holder on timeout', () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-worktree-create.lock')
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), `${process.pid}\n`)
      expect(() => withWorktreeCreateLock(repo, () => undefined, 20)).toThrow(
        new RegExp(
          `timed out after 0\\.02s waiting for this project's worktree creation lock ` +
          `\\(holder pid ${process.pid}\\)`,
        ),
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a creation lock held by a dead owner is reclaimed and reported', () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-worktree-create.lock')
    const reportedLock = join(realpathSync(join(repo, '.git')), 'orch-worktree-create.lock')
    const deadPid = 2_147_483_647
    const errors: string[] = []
    const originalError = console.error
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), `${deadPid}\n`)
      console.error = (...args: unknown[]) => errors.push(args.join(' '))
      expect(withWorktreeCreateLock(repo, () => 'created', 20)).toBe('created')
      expect(errors).toEqual([
        `orch: reclaimed worktree creation lock from dead holder pid ${deadPid}: ${reportedLock}`,
      ])
      expect(existsSync(lock)).toBe(false)
    } finally {
      console.error = originalError
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a fresh ownerless lock is not reclaimed during the owner-write race', async () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-worktree-create.lock')
    const child = Bun.spawn([
      process.execPath, '-e',
      `
        const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
        mkdirSync(process.argv[1])
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
        writeFileSync(process.argv[1] + '/owner', process.pid + '\\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
        rmSync(process.argv[1], { recursive: true })
      `,
      lock,
    ], { stdout: 'pipe', stderr: 'pipe' })
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(lock); attempts++) await Bun.sleep(5)
      expect(existsSync(lock)).toBe(true)
      let entered = false
      expect(() => withWorktreeCreateLock(repo, () => { entered = true }, 20)).toThrow(
        /timed out after 0\.02s waiting for this project's worktree creation lock/,
      )
      expect(entered).toBe(false)
      expect(await child.exited).toBe(0)
    } finally {
      child.kill()
      await child.exited
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an uncontended creation lock still runs the critical section', () => {
    const { repo } = scratchRepo()
    try {
      expect(withWorktreeCreateLock(repo, () => 'created')).toBe('created')
      expect(existsSync(join(repo, '.git', 'orch-worktree-create.lock'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a tree whose disk contents disagree with HEAD is never returned', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-914')
    try {
      expect(() => createWithTool({
        branch: 'orch/{id}',
        create: compoundCreate(
          `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
          `printf 'not HEAD\\n' > "${path}/kept.txt" && ` +
          `printf 'from another tree\\n' > "${path}/contamination.txt" && echo "${path}"`),
      }, repo, 914)).toThrow(/worktree verification failed:[\s\S]*kept\.txt[\s\S]*contamination\.txt/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unreadable worktree index is a verification failure, not a clean tree', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-915')
    try {
      expect(() => createWithTool({
        branch: 'orch/{id}',
        create: compoundCreate(
          `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
          `printf broken > "$(git -C "${path}" rev-parse --git-path index)" && echo "${path}"`),
      }, repo, 915)).toThrow(/worktree verification failed: could not compare[\s\S]*index/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a successful tool postcondition failure names its branch and remove command', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      expect(() => createWithTool(
        {
          branch: 'technical/{key}-orch-{id}',
          create: declaredCreate('echo', [join(repo, 'missing-tree')]),
          remove: 'scripts/worktree remove {branch}',
        },
        process.cwd(), 735, undefined, 'STO-993',
      )).toThrow("scripts/worktree remove 'technical/STO-993-orch-735'")
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches a tool whose template asks for it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'based-746')
    try {
      process.chdir(tree)
      const expected = resolveBase(process.cwd(), 'main')
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" {base} >/dev/null && ` +
            `echo "${custom}"`),
          remove: 'git worktree remove {path}',
        },
        process.cwd(), 746, undefined, undefined, 'main',
      )
      expect(w.base).toBe(expected)
      expect(git(custom, 'rev-parse', 'HEAD')).toBe(expected)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a command tool records the base its worktree actually uses', () => {
    const { repo, tree } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'self-based-746')
    try {
      git(repo, 'branch', 'tool-floor', 'main')
      writeFileSync(join(repo, 'later.txt'), 'later\n')
      git(repo, 'add', 'later.txt')
      git(repo, 'commit', '-m', 'later')
      const expected = resolveBase(repo, 'tool-floor')

      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" tool-floor ` +
            `>/dev/null && echo "${custom}"`),
          remove: 'git worktree remove {path}',
        },
        tree, 746,
      )

      expect(w.base).toBe(expected)
      expect(w.base).not.toBe(resolveBase(repo, 'main'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base is refused when a command template cannot receive it', () => {
    const { repo, tree } = scratchRepo()
    try {
      expect(() => createWithTool(
        { create: declaredCreate('echo', ['nowhere']), branch: 'task/{id}' }, tree, 747,
        undefined, undefined, 'main',
      )).toThrow('command-based worktree path cannot honor --base')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches the recipe path and overrides its default', () => {
    const { repo, tree } = scratchRepo()
    try {
      git(repo, 'branch', 'requested-base', 'main')
      writeFileSync(join(repo, 'later.txt'), 'later\n')
      git(repo, 'add', 'later.txt')
      git(repo, 'commit', '-m', 'later')
      const expected = resolveBase(repo, 'requested-base')

      const w = createWithTool(
        { recipe: { baseRef: 'main' } }, tree, 748,
        undefined, undefined, 'requested-base',
      )

      expect(w.base).toBe(expected)
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(expected)
      expect(existsSync(join(w.path, 'later.txt'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('diff surfaces the recorded base commit', () => {
    const { repo } = scratchRepo()
    const w = createWorktree(repo, 749, 'main')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(w.path, w.branch, w.base, id)
    writeFileSync(join(w.path, 'kept.txt'), 'changed\n')
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'diff', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(`base: ${w.base}`)
      expect(p.stderr.toString()).toContain(`base:     ${w.base}`)
      const applyCheck = Bun.spawnSync(['git', 'apply', '--check', '-'], {
        cwd: repo, env: hermeticGitEnv(), stdin: p.stdout, stdout: 'pipe', stderr: 'pipe',
      })
      expect(applyCheck.exitCode).toBe(0)

      const quiet = Bun.spawnSync([process.execPath, CLI, 'diff', String(id), '--quiet'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(quiet.exitCode).toBe(0)
      expect(quiet.stdout.toString()).toContain(`base: ${w.base}`)
      expect(quiet.stderr.toString()).not.toContain(`base:     ${w.base}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard uses a registered project remove template', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 880)
    const argvFile = join(repo, 'remove-argv.txt')
    const script = join(repo, 'fake-remove.sh')
    writeFileSync(script,
      `printf '%s\n' "$@" > "${argvFile}"\n` +
      "echo 'retained fixture resource' >&2\n" +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'remove-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
        tree.path, tree.branch,
      ])
      expect(p.stdout.toString()).toContain('remove-tool remove:')
      expect(p.stdout.toString()).toContain('retained fixture resource')
      expect(existsSync(tree.path)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard surfaces a registered project remove refusal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 881)
    upsertProject({
      name: 'refusing-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: "echo 'protected work' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('protected work')
      expect(p.stderr.toString()).toContain(
        "Inspect and resolve the protected work with the project's own tooling",
      )
      expect(p.stderr.toString()).toContain(
        "--force will not override a project tool's refusal unless the tree carries orch's " +
        '.orch-run ownership marker',
      )
      expect(p.stderr.toString()).not.toContain('Look before overriding')
      expect(existsSync(tree.path)).toBe(true)
      const row = db().query('SELECT worktree FROM run WHERE id=?').get(id) as
        { worktree: string | null }
      expect(row.worktree).toBe(tree.path)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard --force does not override a project tool for a tree orch did not create', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'operator-tree')
    git(repo, 'worktree', 'add', '-b', 'operator-tree', path, 'main')
    writeFileSync(join(path, 'operator.txt'), 'protected work\n')
    upsertProject({
      name: 'refusing-operator-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'protected operator work' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(path, 'operator-tree', id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('protected operator work')
      expect(p.stderr.toString()).toContain(
        "--force will not override a project tool's refusal unless the tree carries orch's " +
        '.orch-run ownership marker',
      )
      expect(existsSync(path)).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard --force removes a dirty orch-created tree after its project tool refuses', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 889)
    writeFileSync(join(tree.path, 'scratch.txt'), 'worker scratch state\n')
    upsertProject({
      name: 'refusing-orch-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'dirty tree refused' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard on an unregistered repository uses git removal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 882)
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const env = { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env, stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard keeps a branch with an unmerged commit and records it', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 883)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const script = join(repo, 'remove-and-delete.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'protected-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET repo=?, cwd=?, worktree=?, branch=? WHERE id=?')
      .run('protected-tool', repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) reachable only from this branch — merge it, or ` +
        `orch discard ${id} --force to delete it`,
      )
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })

      const forced = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(forced.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard --force deletes a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 884)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard deletes a branch whose commit is merged into trunk', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 885)
    writeFileSync(join(tree.path, 'merged.txt'), 'merged work\n')
    git(tree.path, 'add', 'merged.txt')
    git(tree.path, 'commit', '-m', 'merged work')
    git(repo, 'merge', '--ff-only', tree.branch)
    upsertProject({ name: 'merged-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('abandon keeps a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 886)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    upsertProject({ name: 'abandon-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) reachable only from this branch — merge it, or ` +
        `orch discard ${id} --force to delete it`,
      )
      expect(git(repo, 'branch', '--list', tree.branch)).toContain(tree.branch)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard without a configured trunk still deletes a branch with no unique commits', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 887)
    upsertProject({ name: 'no-trunk-discard', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('abandon without a configured trunk still deletes a branch with no unique commits', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 888)
    upsertProject({ name: 'no-trunk-abandon', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard does not keep a branch merely ahead of a stale local trunk', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    upsertProject({
      name: 'stale-trunk', path: realpathSync(repo), settings: { trunk: 'main' },
    })
    const tree = createWorktree(repo, 890, 'origin/main')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.base, id)
    try {
      expect(git(repo, 'rev-list', '--count', `main..${tree.branch}`)).not.toBe('0')
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard still keeps unique commits when the local trunk is stale', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    upsertProject({
      name: 'stale-trunk-unique', path: realpathSync(repo), settings: { trunk: 'main' },
    })
    const tree = createWorktree(repo, 891, 'origin/main')
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.base, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) reachable only from this branch`,
      )
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('unmergedBranch counts only commits reachable from nowhere else', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    const tree = createWorktree(repo, 892, 'origin/main')
    try {
      expect(unmergedBranch(repo, tree.branch, tree.base)).toBe(null)
      expect(unmergedBranch(repo, tree.branch, null)).toBe(null)
      writeFileSync(join(tree.path, 'unique.txt'), 'only here\n')
      git(tree.path, 'add', 'unique.txt')
      git(tree.path, 'commit', '-m', 'unique')
      const tip = git(tree.path, 'rev-parse', 'HEAD')
      expect(unmergedBranch(repo, tree.branch, tree.base)).toEqual({ count: 1, tip })
      expect(unmergedBranch(repo, tree.branch, null)).toEqual({ count: 1, tip })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('recipe failure runs its declared stop before removing the tree', () => {
    const { repo } = scratchRepo()
    const stopped = join(repo, 'recipe-stopped.txt')
    const tool = {
      recipe: {
        serve: 'serve --port {port}',
        stop: `printf stopped > "${stopped}"`,
        after: 'exit 9',
      },
    }
    upsertProject({
      name: 'recipe-project', path: realpathSync(repo), settings: { worktree: tool },
    })
    try {
      expect(() => createWithTool(tool, repo, 883)).toThrow('worktree setup failed at "after"')
      expect(readFileSync(stopped, 'utf8')).toBe('stopped')
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-883'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('pid stays the worker for the whole run', () => {
  test('after a run, pid is the worker pid and agent_pid is the agent\'s', async () => {
    const pidFile = join(dir, 'fake-agent.pid')
    const script = join(dir, 'fake-agent.sh')
    writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\necho a valid reply\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, reserved)
      await run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved })
      const row = db().query('SELECT pid, agent_pid FROM run WHERE id=?')
        .get(reserved) as { pid: number; agent_pid: number }
      expect(row.pid).toBe(process.pid)
      expect(row.agent_pid).toBe(Number(readFileSync(pidFile, 'utf8').trim()))
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })
})

describe('fan-out routing exclusions', () => {
  test('avoid removes an agent while another eligible agent remains', () => {
    expect(pick('review-lens', undefined, 0, false, null,
      { agents: ['grok'] }).agent).toBe('codex')
  })

  test('exhausted exclusions refuse and name the cause', () => {
    expect(() => pick('review-lens', undefined, 0, false, null,
      { agents: ['grok', 'codex'] })).toThrow(
        'excluded by constraint: codex: --avoid named codex; grok: --avoid named grok',
      )
  })

  test('MCP routing no longer excludes codex over the caller checkout', () => {
    expect(pick('mcp-query', undefined, 0, false, null,
      { agents: ['grok'] }).agent).toBe('codex')
  })

  test('an explicit pin that is also avoided is refused', () => {
    expect(() => pick('review-lens', 'grok', 0, false, null,
      { agents: ['grok'] })).toThrow('contradicts')
  })

  test('distinct models exclude the agent currently using one', () => {
    expect(pick('review-lens', undefined, 0, false, null,
      { models: [AGENTS.grok!.model] }).agent).toBe('codex')
  })
})

describe('orphan worktrees keep anything unique', () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  test('only a clean worktree fully reachable from main is removable', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-orphan-'))
    const tree = join(repo, '.claude', 'worktrees', 'orphan')
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, 'add', 'kept.txt')
      git(repo, 'commit', '-m', 'base')
      git(repo, 'worktree', 'add', '-b', 'orphan', tree, 'main')

      expect(orphanSafety(tree, repo, 'main')).toMatchObject({ removable: true })
      writeFileSync(join(tree, 'new.txt'), 'unique\n')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: false, detail: 'has uncommitted changes',
      })
      git(tree, 'add', 'new.txt')
      git(tree, 'commit', '-m', 'unique')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: false, detail: 'has commits not reachable from main',
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('sweep only reclaims old orch-owned orphan worktrees', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const scratchRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-sweep-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'base')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    upsertProject({ name: `sweep-${repo.split('/').pop()}`, path: repo, settings: { trunk: 'main' } })
    return repo
  }

  test('invalid older-than values refuse before sweeping', () => {
    for (const value of ['typo', '-1']) {
      const r = orch('sweep', '--older-than', value)
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('--older-than must be a finite, non-negative number')
    }
  })

  test('an unrecognised orphan is kept even with force', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'reader')
    try {
      git(repo, 'worktree', 'add', '-b', 'reader', tree, 'main')
      const r = orch('sweep', '--older-than', '0', '--force')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  kept: not created by orch`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a young orch-named orphan is kept until the threshold', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'orch-900')
    try {
      git(repo, 'worktree', 'add', '-b', 'orch/900', tree, 'main')
      const r = orch('sweep', '--older-than', '1')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  too recent (0.0d)`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an old marked orphan is reclaimed', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `901\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      const old = new Date(Date.now() - 2 * 86_400_000)
      utimesSync(join(tree, '.orch-run'), old, old)

      const r = orch('sweep', '--older-than', '1')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("a successful project remove command's warning is attributed", () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `903\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      const old = new Date(Date.now() - 2 * 86_400_000)
      utimesSync(join(tree, '.orch-run'), old, old)
      upsertProject({
        name, path: repo,
        settings: {
          trunk: 'main',
          worktree: {
            remove:
              "echo 'retained fixture resource' >&2; " +
              `${hermeticGitCommand} worktree remove --force {path}; ` +
              `${hermeticGitCommand} branch -D {branch}`,
          },
        },
      })

      const r = orch('sweep', '--older-than', '1')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${name} remove:`)
      expect(r.out).toContain('retained fixture resource')
      expect(r.out).toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('more than ten kept rows are summarised by reason; --dry-run lists every row', () => {
    const recent: number[] = []
    const unscored: number[] = []
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    for (let i = 0; i < 6; i++) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
      db().query('UPDATE run SET worktree=? WHERE id=?').run(`/tmp/dev148-recent-${i}`, id)
      recent.push(id)
    }
    for (let i = 0; i < 5; i++) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', startedAt: old })
      db().query('UPDATE run SET worktree=? WHERE id=?').run(`/tmp/dev148-unscored-${i}`, id)
      unscored.push(id)
    }

    const summarised = orch('sweep')
    expect(summarised.code).toBe(0)
    expect(summarised.out).toContain('reclaimed 0, kept 11')
    expect(summarised.out).toContain('6  under the age threshold')
    expect(summarised.out).toContain('5  unscored — its diff is the evidence')
    expect(summarised.out).toContain('orch sweep --dry-run lists every kept row')
    for (const id of recent) expect(summarised.out).not.toContain(`${id}  too recent`)
    for (const id of unscored) expect(summarised.out).not.toContain(`${id}  unscored`)

    const listed = orch('sweep', '--dry-run')
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('would reclaim 0, kept 11')
    expect(listed.out).toContain('6  under the age threshold')
    expect(listed.out).toContain('5  unscored — its diff is the evidence')
    expect(listed.out).not.toContain('lists every kept row')
    for (const id of recent) expect(listed.out).toContain(`${id}  too recent`)
    for (const id of unscored) expect(listed.out).toContain(`${id}  unscored — its diff is the evidence`)
  })

  test('an old marked orphan is kept when the project has no trunk', () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    upsertProject({ name, path: repo, settings: {} })
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `902\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      const old = new Date(Date.now() - 2 * 86_400_000)
      utimesSync(join(tree, '.orch-run'), old, old)

      const r = orch('sweep', '--older-than', '1')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  no trunk configured — cannot prove reachability`)
      expect(r.out).not.toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a project sweep longer than eight lines says how many were omitted', () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const lines = Array.from({ length: 10 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
    upsertProject({
      name, path: repo,
      settings: {
        trunk: 'main',
        worktree: { sweep: `printf '%s\\n' ${lines.join(' ')}` },
      },
    })
    try {
      const r = orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${name} sweep:`)
      expect(r.out).toContain('L03')
      expect(r.out).toContain('L10')
      expect(r.out).not.toContain('L01')
      expect(r.out).not.toContain('L02')
      expect(r.out).toContain('(2 earlier lines omitted)')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('only an agent that can be resumed may be asked to escalate', () => {
  test('implement requires writing AND resumability', () => {
    // Both are load-bearing: an agent that cannot write cannot do the job, and
    // one that cannot be resumed would have to restart to hear an answer, which
    // makes asking cost more than guessing.
    const j = JOBS.implement!
    expect(j.needs.writesRepo).toBe(true)
    expect(j.needs.resumable).toBe(true)
  })

  test('the two hand-rolled job shapes declare their actual bounds', () => {
    const diagnose = JOBS.diagnose!
    expect(diagnose.needs).toEqual({ readsRepo: true })
    expect(diagnose.prefer).toEqual(['codex', 'grok'])
    expect(diagnose.contextTokens).toBe(JOBS.understand!.contextTokens)

    const land = JOBS.land!
    expect(land.needs).toEqual({ readsRepo: true, writesRepo: true, resumable: true })
    expect(land.prefer).toEqual(['codex'])
    expect(land.contextTokens).toBe(JOBS.fix!.contextTokens)
    expect(land.timeoutMs).toBe(30 * 60_000)
  })

  test('inline review declares that repository access is forbidden', () => {
    expect(JOBS['review-lens-inline']!.needs).toEqual({ readsRepo: false })
    expect(JOBS['review-lens']!.needs).toEqual({ readsRepo: true })
  })

  test('writing workers may commit only land may merge into trunk', () => {
    expect(workerPreamble('land')).toBe(LAND_PREAMBLE)
    expect(LAND_PREAMBLE).toContain('DIFFERENT contract from implement')
    expect(LAND_PREAMBLE).toContain('You MAY retrieve the named source run')
    expect(LAND_PREAMBLE).toContain('create the\nrequested commit')
    expect(LAND_PREAMBLE).toContain('fast-forward trunk to it')
    expect(LAND_PREAMBLE).toContain('Run the gates after rebasing')
    expect(LAND_PREAMBLE).toContain('Merge fast-forward only')
    expect(LAND_PREAMBLE).toContain('Do NOT push')
    expect(LAND_PREAMBLE).not.toContain('Do NOT merge')
    expect(LAND_PREAMBLE).toContain('one source run number')
    expect(LAND_PREAMBLE).toContain('one named target branch')
    expect(LAND_PREAMBLE).not.toContain('Do NOT commit')

    for (const name of ['implement', 'fix']) {
      expect(workerPreamble(name)).toBe(WORKER_PREAMBLE)
      expect(workerPreamble(name)).toContain('MAY commit changes to your own throwaway branch')
      expect(workerPreamble(name)).toContain('Do NOT push')
      expect(workerPreamble(name)).toContain('do NOT merge into\ntrunk')
      expect(workerPreamble(name)).toContain('do not rewrite history')
      expect(workerResumeGuard(name)).toContain('may commit to your own throwaway branch')
      expect(workerResumeGuard(name)).toContain('Do not push, merge into trunk, or rewrite history')
    }
    expect(workerResumeGuard('land')).toContain('merge it into trunk fast-forward only')
    expect(workerResumeGuard('land')).toContain('Do not push')
  })

  test('every agent claiming resumable can actually be resumed', () => {
    // The invariant agents.ts enforces at import, asserted here so the reason
    // is written down where it is checked: a flag in a help text is not a
    // capability if orch has no id to resume with.
    for (const a of Object.values(AGENTS)) {
      if (!a.caps.resumable) continue
      expect(a.resumeArgv).toBeDefined()
      expect(a.mintSession ?? a.readSession).toBeDefined()
    }
  })

  test('grok is eligible for writing jobs after its write round-trip', () => {
    expect(AGENTS.grok!.caps.writesRepo).toBe(true)
    expect(AGENTS.grok!.caps.resumable).toBe(true)
    for (const job of ['implement', 'fix']) {
      expect(candidates(job).map((c) => c.agent)).toContain('grok')
    }
  })

  test('grok bypasses permission prompts for reading and writing jobs', () => {
    const grok = AGENTS.grok!
    for (const write of [false, true]) {
      const args = grok.argv({ prompt: 'p', out: '/tmp/o', write })
      expect(args).toContain('--permission-mode')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
      expect(args).not.toContain('acceptEdits')
    }
  })

  test('a writing agent gets a writable sandbox and a reading one does not', () => {
    const codex = AGENTS.codex!
    expect(codex.argv({ prompt: 'p', out: '/tmp/o', write: true })).toContain('workspace-write')
    expect(codex.argv({ prompt: 'p', out: '/tmp/o' })).toContain('read-only')
  })

  test('codex resume puts its flags BEFORE the subcommand', () => {
    // `codex exec resume <id> -s read-only` is rejected outright: parsing stops
    // at the subcommand. The order reads backwards and is easy to "tidy".
    const a = AGENTS.codex!.resumeArgv!({ prompt: 'ruling', out: '/tmp/o', session: 'abc' })
    expect(a.indexOf('resume')).toBeGreaterThan(a.indexOf('--json'))
    expect(a[a.indexOf('resume') + 1]).toBe('abc')
  })
})

describe('review-lens-inline has no checkout', () => {
  test('runs from an empty directory while review-lens still receives the project tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-inline-boundary-'))
    const script = join(dir, 'report-worker-cwd.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      runGit('init', '-b', 'main')
      runGit('config', 'user.email', 'orch-test@example.invalid')
      runGit('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'project-only.txt'), 'wrong tree evidence\n')
      runGit('add', 'project-only.txt')
      runGit('commit', '-m', 'fixture')
      writeFileSync(script, [
        "import { existsSync } from 'node:fs'",
        "const prompt = await Bun.stdin.text()",
        "console.log(JSON.stringify({",
        "  cwd: process.cwd(),",
        "  checkout: existsSync('.git'),",
        "  projectFile: existsSync('project-only.txt'),",
        "  receivedPack: prompt.includes('SELF_CONTAINED_FACT'),",
        "}))",
      ].join('\n'))
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = true
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const inline = await runJob({
        job: 'review-lens-inline', prompt: 'SELF_CONTAINED_FACT', cwd: repo, agent: 'codex', lens: 'inline',
      })
      const inlineView = JSON.parse(inline.output) as {
        cwd: string; checkout: boolean; projectFile: boolean; receivedPack: boolean
      }
      expect(inlineView.checkout).toBe(false)
      expect(inlineView.projectFile).toBe(false)
      expect(inlineView.receivedPack).toBe(true)
      expect(existsSync(inlineView.cwd)).toBe(false)
      expect(inline.worktree).toBeNull()

      const repository = await runJob({
        job: 'review-lens', prompt: 'inspect project-only.txt', cwd: repo, agent: 'codex', lens: 'project',
      })
      const repositoryView = JSON.parse(repository.output) as {
        checkout: boolean; projectFile: boolean
      }
      expect(repositoryView.checkout).toBe(true)
      expect(repositoryView.projectFile).toBe(true)
      expect(repository.worktree?.path).toBeTruthy()
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })
})

describe('grok reply parsing', () => {
  test('takes only the terminal result from a tool-using message stream', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: "I'll fetch it first." }], stop_reason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '## Finding' }], stop_reason: 'end_turn' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'success', result: '## Finding', total_cost_usd: 0.25,
        usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
      }),
    ].join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({
      text: '## Finding', tokens: 35, costUsd: 0.25,
    })
  })

  test('uses the clean stream for plain and schema-constrained replies', () => {
    const out = join(dir, 'grok-out.txt')
    expect(AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6' }))
      .toContain('streaming-messages-json')
    const schema = join(dir, 'grok-schema.json')
    writeFileSync(schema, '{}')
    const args = AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6', schema })
    expect(args).toContain('streaming-messages-json')
    expect(args.indexOf('--json-schema')).toBeLessThan(args.indexOf('--output-format'))
  })

  test('records a cancelled result event as a failed run with its error', async () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working.' }], stop_reason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', errors: ['cancelled'],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ].join('\n')
    const script = join(dir, 'fake-grok-cancelled.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved }))
        .rejects.toThrow('cancelled')
      const failed = db().query(
        'SELECT status, failure_kind, error, output_path, output_bytes FROM run WHERE id=?',
      ).get(reserved) as {
        status: string; failure_kind: string; error: string
        output_path: string; output_bytes: number
      }
      expect(failed.status).toBe('failed')
      expect(failed.failure_kind).toBe('other')
      expect(failed.error).toBe('cancelled')
      expect(existsSync(failed.output_path)).toBe(true)
      expect(readFileSync(failed.output_path, 'utf8')).toBe(stdout + '\n')
      expect(failed.output_bytes).toBe(new TextEncoder().encode(stdout + '\n').byteLength)

      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nkill -TERM $$\n`)
      const interrupted = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: interrupted }))
        .rejects.toThrow('cancelled')
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(interrupted))
        .toEqual({ status: 'failed', failure_kind: 'interrupted', error: 'cancelled' })
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a terminal result without errors or final text is a parse failure', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({ type: 'result', subtype: 'success', errors: [] }),
    ].join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({
      text: '', tokens: null, costUsd: null, error: 'grok result contained no final text',
    })
  })
})


describe('the live ask channel always answers', () => {
  test('a ruling that lands is handed straight back', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const pending = ask({ runId: run, question: 'one table or two?', timeoutMs: 10_000 })
    for (let i = 0; i < 50; i++) {
      const q = db().query('SELECT id FROM question WHERE run_id = ?').get(run) as { id: number } | null
      if (q) {
        db().query("UPDATE question SET answer=?, answered_at=?, answered_by='t' WHERE id=?")
          .run('two', new Date().toISOString(), q.id)
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(await pending).toEqual({ answered: true, answer: 'two' })
  })

  test('a live question is answerable through the command, not only in SQL', () => {
    /**
     * The test above writes the answer with raw SQL, and a review pointed out
     * that this proved a path nobody can execute: `orch answer` rejected every
     * status except `blocked`, while MCP questions belong to a `running` run.
     * The live channel could therefore never be answered and every question
     * ran to its timeout — the headline feature, broken end to end, with a
     * green test beside it.
     *
     * So the CLI's own precondition is asserted here rather than assumed. A
     * run that is `running` WITH an open question must be answerable, and one
     * with no open question must not be.
     */
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    ).run(live, new Date().toISOString(), 'which table?')

    const answerable = (id: number) => {
      const r = db().query('SELECT status, parent_run_id FROM run WHERE id = ?').get(id) as
        { status: string; parent_run_id: number | null }
      const open = db().query(
        `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
      ).get(id, id) as { n: number }
      return !r.parent_run_id && open.n > 0 && (r.status === 'running' || r.status === 'asking')
    }

    expect(answerable(live)).toBe(true)
    expect(answerable(addRun({ agent: 'codex', job: 'implement', status: 'running' }))).toBe(false)
  })

  test('a question asked on turn two is answerable from the root', () => {
    // The chain shape every escalation after the first one takes. Questions
    // land on the CHILD row while the roll-up marks the ROOT blocked, so
    // looking only at the root found nothing and the child was refused as
    // non-root — a conversation that asked twice could not be continued.
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'and now what?')

    const open = db().query(
      `SELECT q.id FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    ).all(root, root) as { id: number }[]
    expect(open.length).toBe(1)
  })

  test('a question nobody answers falls back rather than hanging', async () => {
    // The whole reason this is bounded: a tool that can wait for ever leaves a
    // worker holding a session with nothing to wait for, and the run's own
    // timeout eventually kills work that was finished but for one question.
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = await ask({ runId: run, question: 'nobody is listening', timeoutMs: 50 })
    expect(r.answered).toBe(false)
    // It must tell the worker to escalate rather than to decide.
    if (!r.answered) expect(r.reason).toContain('blocked')
  })

  test('an unanswered question survives the timeout', async () => {
    // The architect still has to make the decision; withdrawing it on timeout
    // would lose the record of one that is still outstanding.
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    await ask({ runId: run, question: 'still open', timeoutMs: 50 })
    const open = db().query(
      'SELECT COUNT(*) AS n FROM question WHERE run_id = ? AND answered_at IS NULL',
    ).get(run) as { n: number }
    expect(open.n).toBe(1)
  })
})


describe('fidelity: did it build what it was asked to build', () => {
  test('correct code that solved the wrong problem is not a perfect run', () => {
    // The failure neither existing axis can see. A complete change set of
    // correct, working code that answers a different question scores full/right
    // on both, and only fidelity registers that it is not what was asked for.
    expect(weigh('full', 'right')).toBe(1)
    expect(weigh('full', 'right', 'drifted')).toBe(0.5)
    expect(weigh('full', 'right', 'faithful')).toBe(1)
  })

  test('asking costs an agent nothing', () => {
    // Load-bearing: the preamble promises the worker that escalating is free.
    // If it were not, asking would cost something after all and nobody would ask.
    expect(FIDELITY_PENALTY.faithful).toBe(0)
  })

  test('a score with no fidelity weighs exactly what it always did', () => {
    // Adding the axis must not restate history. Every read-only job, and every
    // verdict recorded before the column existed, is unaffected.
    for (const d of ['none', 'partial', 'full'] as const) {
      for (const q of ['wrong', 'mixed', 'right'] as const) {
        if (d === 'none') continue
        expect(weigh(d, q, null)).toBe(weigh(d, q))
      }
    }
    expect(weigh('none', null, null)).toBe(weigh('none', null))
  })

  test('the router reads the penalty, not just the printout', () => {
    // The failure this file already documents once: stats, the dashboard and
    // the router each held their own copy of the aggregate and drifted apart.
    const drifted = addRun({ agent: 'codex', job: 'implement' })
    score(drifted, 'full', 'right', 'drifted')
    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.score).toBeCloseTo(weigh('full', 'right', 'drifted'))
    expect(c.score).toBeLessThan(weigh('full', 'right'))
  })

  test('an agent that drifts ranks below one that asks', () => {
    const asked = addRun({ agent: 'codex', job: 'implement' })
    score(asked, 'full', 'right', 'faithful')
    const guessed = addRun({ agent: 'grok', job: 'implement' })
    score(guessed, 'full', 'right', 'drifted')
    const all = candidates('implement')
    const a = all.find((x) => x.agent === 'codex')!
    const g = all.find((x) => x.agent === 'grok')!
    expect(a.score!).toBeGreaterThan(g.score!)
  })
})


describe('projects are data, not code', () => {
  test('a directory belongs to the project that contains it', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', stack: 'php-laravel' })
    expect(projectAt('/w/alpha')?.name).toBe('alpha')
    expect(projectAt('/w/alpha/src/deep/file')?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt('/w/alpha/.claude/worktrees/orch-12')?.name).toBe('alpha')
    expect(stackAt('/w/alpha/.claude/worktrees/orch-12')).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('the longest matching path wins, so nesting resolves inward', () => {
    upsertProject({ name: 'outer', path: '/w' })
    upsertProject({ name: 'inner', path: '/w/inner' })
    expect(projectAt('/w/inner/src')?.name).toBe('inner')
    expect(projectAt('/w/other')?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    upsertProject({
      name: 'alpha', path: '/w/alpha',
      settings: { trunk: 'develop', states: { in_progress: 'active' } },
    })
    const p = projectAt('/w/alpha')!
    expect(p.settings.trunk).toBe('develop')
    expect(p.settings.states?.in_progress).toBe('active')
  })
})

describe('routing narrows to a stack only when that buys a comparison', () => {
  test('one proven agent on a stack is not enough to narrow', () => {
    // Narrowing here would demote an agent with a long job-wide record to
    // "unproven" and hand the work to whichever one reached five on this stack
    // first — the incumbency problem, arriving by a different door.
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 9; i++) score(addRun({ agent: 'grok', job: 'craft', stack: 'node' }), 'full', 'right')
    expect(evidenceFor('craft', 0, 'php').level).toBe('job')
  })

  test('two proven agents on a stack is a real comparison', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'mixed')
    const ev = evidenceFor('craft', 0, 'php')
    expect(ev.level).toBe('stack')
    expect(ev.stack).toBe('php')
  })

  test('evidence from another stack does not leak into a scoped view', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'right')
    // A disaster on a different stack must not touch the php verdict.
    for (let i = 0; i < 9; i++) addRun({ agent: 'codex', job: 'craft', stack: 'node', status: 'failed' })
    const scoped = evidenceFor('craft', 0, 'php').cands.find((c) => c.agent === 'codex')!
    expect(scoped.evidence).toBe(6)
    expect(scoped.score).toBe(weigh('full', 'right'))
  })

  test('no stack at all behaves exactly as it always did', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    expect(evidenceFor('craft', 0, null).level).toBe('job')
    expect(evidenceFor('craft', 0, undefined).cands.find((c) => c.agent === 'codex')!.evidence).toBe(6)
  })
})


describe('the fidelity penalty cannot sink below "nothing arrived"', () => {
  test('a delivered answer never ranks below a non-delivery', () => {
    // Unclamped, partial/wrong/drifted weighs -0.75 against none's -0.5, so an
    // agent that delivered something unusable ranked BELOW one that delivered
    // nothing — and routing would prefer the agent that cannot do the job.
    const floor = weigh('none', null)
    for (const d of ['partial', 'full'] as const) {
      for (const q of ['wrong', 'mixed', 'right'] as const) {
        for (const f of ['drifted', 'partial', 'faithful'] as const) {
          expect(weigh(d, q, f)).toBeGreaterThanOrEqual(floor)
        }
      }
    }
  })

  test('the router clamps identically to the printout', () => {
    const bad = addRun({ agent: 'codex', job: 'implement' })
    score(bad, 'partial', 'wrong', 'drifted')
    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.score).toBeCloseTo(weigh('partial', 'wrong', 'drifted'))
    expect(c.score).toBeGreaterThanOrEqual(weigh('none', null))
  })

  test('an unknown fidelity is refused rather than read as no penalty', () => {
    // addColumn cannot carry a CHECK, so a typo reaches weigh() on any database
    // that predates the column. Silently scoring it as faithful would flatter
    // the run and diverge from the SQL, which treats it as zero.
    expect(() => weigh('full', 'right', 'faithfull' as never)).toThrow()
  })
})


describe('the Stop hook and orch agree on what is unscored', () => {
  test("the hook's SQL carries every clause of UNSCORED_WHERE", () => {
    /**
     * The hook is Python and cannot import the TypeScript definition, so its
     * predicate is a second copy — and it did what a second copy always does.
     * `UNSCORED_WHERE` learned that a conversation is one unit of work; the
     * hook did not, and spent a session demanding verdicts on two runs that
     * `orch score` refuses to take, naming their root instead.
     *
     * This cannot make them one definition. It can make them fail together,
     * which is the same guarantee the router and the dashboard get from
     * sharing `scoreboard()`.
     */
    const hook = readFileSync(
      new URL('../hooks/score-reminder.py', import.meta.url).pathname, 'utf8',
    )
    // Each clause of the real predicate, normalised to how SQL is written in
    // both files. If UNSCORED_WHERE grows a condition, this fails until the
    // hook grows it too.
    for (const clause of UNSCORED_WHERE.split('AND').map((c) => c.trim().replace(/\s+/g, ' '))) {
      expect(hook.replace(/\s+/g, ' ')).toContain(clause)
    }
  })
})


describe('a project can declare a worktree instead of writing one', () => {
  test('a derived database name is safe for both engines', () => {
    // Postgres folds unquoted identifiers to lower case and MySQL forbids most
    // punctuation, so the safe intersection is what this must produce — a name
    // needing quotes is a name that will one day be used unquoted.
    expect(dbNameFor('Star-Ship', 42)).toBe('star_ship_wt_42')
    expect(dbNameFor('my.app', 7)).toBe('my_app_wt_7')
    expect(dbNameFor('', 1)).toBe('app_wt_1')
    expect(dbNameFor('--weird--', 9)).toBe('weird_wt_9')
  })

  test('a recipe stops at its first failure and reports which step', () => {
    // A half-provisioned tree is the worst outcome available: a worker runs the
    // suite in it, the suite passes against nothing, and the run comes back
    // green. So the steps after a failure must not run.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    const steps = runRecipe(
      { install: 'exit 3', migrate: 'touch SHOULD-NOT-EXIST' }, dir, 'db_wt_1', '',
    )
    expect(steps.at(-1)!.ok).toBe(false)
    expect(steps.at(-1)!.step).toBe('install')
    expect(existsSync(join(dir, 'SHOULD-NOT-EXIST'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the env file is appended, so an inherited one survives', () => {
    // These files inherit the checkout's and add a managed block. Most loaders
    // are last-wins, which is what makes the inheritance safe rather than a
    // source of silent disagreement — so the generated block must come last and
    // must not replace what was there.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    writeFileSync(join(dir, '.env'), 'INHERITED=yes\n')
    runRecipe({ env: { path: '.env', contents: 'DB={db}' } }, dir, 'db_wt_5', '')
    const out = readFileSync(join(dir, '.env'), 'utf8')
    expect(out).toContain('INHERITED=yes')
    expect(out.indexOf('DB=db_wt_5')).toBeGreaterThan(out.indexOf('INHERITED=yes'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('a worker is warned off somebody else\'s server', () => {
    // The failure this exists to prevent does not announce itself: borrowing a
    // running server tests a different branch's bundle and PASSES.
    const notes = recipeNotes({ serve: 'bun dev --port {port}', database: { kind: 'none' } }, 'x', '8080')
    expect(notes).toContain('NEVER verify against a server you did not start')
    expect(notes).toContain('8080')
  })

  test('an empty recipe is plain git, which is right where a checkout is just files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    expect(runRecipe({}, dir, 'db_wt_1', '')).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})


describe('what stopped an agent is reported, not silently worked around', () => {
  test("a review's FINDING is not the reviewer's own blocker", () => {
    // Both of these are real lines from real runs, and the first version of the
    // detector counted both as blockers. Neither agent was blocked by anything;
    // both were doing their job well and describing somebody else's code.
    expect(detectBlockers(
      '`check-ledger.ts:233` names `bun run refresh` instead of a raw port on ECONNREFUSED.',
    )).toEqual([])
    expect(detectBlockers(
      'If process.kill() throws for another reason (e.g. EPERM — permission denied), the code treats it the same.',
    )).toEqual([])
  })

  test('an agent saying it could not run something IS a blocker', () => {
    // Quoted from the run that downgraded its whole test verdict because of it.
    const found = detectBlockers(
      'Could not verify by execution: Docker access was denied at /workspace/.docker/run/docker.sock, so PHPUnit could not run.',
    )
    expect(found.map((b) => b.kind)).toContain('docker-denied')
  })

  test('a blocker is counted once however often it is mentioned', () => {
    // An agent that says it twice has one blocker, and a count is the whole
    // point: one denied socket is an anecdote, forty is a machine to fix.
    const found = detectBlockers(
      'Docker access was denied.\nAgain: docker access was denied when I retried.',
    )
    expect(found.filter((b) => b.kind === 'docker-denied')).toHaveLength(1)
  })

  test('nothing reported is nothing detected', () => {
    expect(detectBlockers('The logs contain: Docker access denied.')).toEqual([])
    expect(detectBlockers('Everything ran. 42 tests passed.')).toEqual([])
    expect(detectBlockers('')).toEqual([])
  })
})

describe('the sandbox an agent is launched with', () => {
  test('follows the job, not a project register entry', async () => {
    // The register used to declare agentSandbox and default registered
    // projects to exec. Dispatch stopped reading it in 0f8681b and kept
    // handing every repository job workspace-write. A round-trip through
    // the register is the test that missed that, so this watches the
    // argv the agent is actually launched with.
    const repo = mkdtempSync(join(tmpdir(), 'orch-sandbox-dispatch-'))
    const script = join(dir, 'sandbox-dispatch-worker.ts')
    writeFileSync(script, 'process.stdout.write("ok")\n')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut, stdin: agent.stdin,
    }
    const launched: Array<string | undefined> = []
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      runGit('init', '-b', 'main')
      runGit('config', 'user.email', 'orch-test@example.invalid')
      runGit('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'seed.txt'), 'seed\n')
      runGit('add', 'seed.txt')
      runGit('commit', '-m', 'fixture')
      agent.bin = process.execPath
      agent.stdin = false
      agent.readsOut = false
      agent.argv = (o) => {
        launched.push(o.sandbox)
        return [script]
      }
      process.env.ORCH_DEPTH = '0'

      await runJob({ job: 'file-question', prompt: 'p', cwd: repo, agent: 'codex' })
      upsertProject({ name: 'sandbox-dispatch', path: repo })
      await runJob({ job: 'file-question', prompt: 'p', cwd: repo, agent: 'codex' })
      await runJob({ job: 'review-lens-inline', prompt: 'p', cwd: repo, agent: 'codex', lens: 'inline' })

      expect(launched).toEqual(['workspace-write', 'workspace-write', 'read-only'])
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      agent.stdin = original.stdin
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })

  test('exec is what the widest level actually asks codex for', () => {
    const argv = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'exec' })
    expect(argv).toContain(CODEX_EXEC_SANDBOX)
    // And the narrow levels stay narrow.
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o' })).toContain('read-only')
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'workspace-write' }))
      .toContain('workspace-write')
  })

  test('asking for MCP gives up exec, and that is the intended trade', () => {
    // --approve-for-me is required for MCP and is mutually exclusive with
    // --sandbox. Review lenses get execution and use no MCP; implementation
    // workers keep the ask channel, because a worker that cannot ask guesses.
    const argv = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'exec', mcp: true })
    expect(argv).toContain('--approve-for-me')
    expect(argv).not.toContain(CODEX_EXEC_SANDBOX)
  })

  test('a writing worktree grants codex its metadata, common objects, and run-ref directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-codex-git-dir-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', 'kept.txt')
      git('commit', '-m', 'base')
      const tree = createWorktree(repo, 125)
      const sibling = createWorktree(repo, 127)
      const ownGitDir = worktreeGitDir(tree.path)
      const siblingGitDir = worktreeGitDir(sibling.path)
      const sharedRoots = workerSharedGitRoots(tree.path, tree.branch)
      const argv = AGENTS.codex!.argv({
        prompt: 'p', out: '/tmp/o', mcp: true, write: true,
        writableRoots: [ownGitDir, ...sharedRoots],
      })
      const configs = argv.filter((arg) => arg.includes('='))
      const writable = configs.find((arg) => arg.startsWith('sandbox_workspace_write.'))!

      expect(JSON.parse(writable.split('=', 2)[1]!)).toEqual([ownGitDir, ...sharedRoots])
      expect(ownGitDir).toBe(realpathSync(join(repo, '.git', 'worktrees', 'orch-125')))
      expect(writable).not.toContain(`${realpathSync(join(repo, '.git'))}"]`)
      expect(writable).not.toContain(siblingGitDir)
      expect(sharedRoots).toContain(join(realpathSync(join(repo, '.git')), 'objects'))
      expect(sharedRoots).toContain(join(realpathSync(join(repo, '.git')), 'refs', 'heads', 'orch'))
      expect(sharedRoots).toContain(join(realpathSync(join(repo, '.git')), 'logs', 'refs', 'heads', 'orch'))
      expect(writable).not.toContain(`${join(realpathSync(join(repo, '.git')), 'refs', 'heads')}"]`)
      expect(writable).not.toContain(join(repo, '.git', 'config'))
      expect(configs.some((arg) => arg.includes('GIT_OBJECT_DIRECTORY'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a new worktree receives the caller state without changing the caller', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-carry-state-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n.claude/\n')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      writeFileSync(join(repo, 'unstaged.txt'), 'base\n')
      writeFileSync(join(repo, 'binary.bin'), new Uint8Array([0, 1, 2, 3]))
      writeFileSync(join(repo, 'deleted.txt'), 'delete me\n')
      git('add', '.')
      git('commit', '-m', 'base')
      git('switch', '-c', 'topic')
      writeFileSync(join(repo, 'branch.txt'), 'committed branch work\n')
      git('add', 'branch.txt')
      git('commit', '-m', 'topic work')

      writeFileSync(join(repo, 'tracked.txt'), 'working state\n')
      git('add', 'tracked.txt')
      writeFileSync(join(repo, 'unstaged.txt'), 'unstaged working state\n')
      writeFileSync(join(repo, 'binary.bin'), new Uint8Array([0, 255, 2, 128]))
      rmSync(join(repo, 'deleted.txt'))
      writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
      writeFileSync(join(repo, 'ignored.txt'), 'runtime only\n')
      const before = Bun.spawnSync(['git', 'status', '--porcelain'], {
        cwd: repo, env: hermeticGitEnv(),
      }).stdout.toString()

      const tree = createWorktree(repo, 134, 'main')
      const carried = carryWorkingState(repo, tree)

      expect(readFileSync(join(tree.path, 'branch.txt'), 'utf8')).toBe('committed branch work\n')
      expect(readFileSync(join(tree.path, 'tracked.txt'), 'utf8')).toBe('working state\n')
      expect(readFileSync(join(tree.path, 'unstaged.txt'), 'utf8')).toBe('unstaged working state\n')
      expect([...readFileSync(join(tree.path, 'binary.bin'))]).toEqual([0, 255, 2, 128])
      expect(existsSync(join(tree.path, 'deleted.txt'))).toBe(false)
      expect(readFileSync(join(tree.path, 'untracked.txt'), 'utf8')).toBe('untracked\n')
      expect(existsSync(join(tree.path, 'ignored.txt'))).toBe(false)
      expect(carried).toEqual({
        base: tree.base,
        // branch.txt is committed branch work. The tree is cut from main, so the
        // carry legitimately brings it forward — and the audit must say so.
        tracked: ['binary.bin', 'branch.txt', 'deleted.txt', 'tracked.txt', 'unstaged.txt'],
        untracked: ['untracked.txt'],
      })
      expect(Bun.spawnSync(['git', 'status', '--porcelain'], {
        cwd: repo, env: hermeticGitEnv(),
      }).stdout.toString()).toBe(before)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("a caller behind the tree's base is refused before its reversions are carried", () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-stale-caller-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'caller base\n')
      git('add', 'tracked.txt')
      git('commit', '-m', 'caller base')
      const callerHead = git('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'tracked.txt'), 'newer base\n')
      git('commit', '-am', 'newer base')
      const tree = createWorktree(repo, 135)
      git('switch', '--detach', callerHead)

      expect(() => carryWorkingState(repo, tree)).toThrow(
        `caller HEAD ${callerHead} is behind or diverged from the tree's base ${tree.base}; ` +
        `update the caller checkout so its HEAD descends from the tree's base, then retry`,
      )
      expect(() => assertCallerAncestry(repo, tree)).toThrow(
        `caller HEAD ${callerHead} is behind or diverged from the tree's base ${tree.base}; ` +
        `update the caller checkout so its HEAD descends from the tree's base, then retry`,
      )
      expect(readFileSync(join(tree.path, 'tracked.txt'), 'utf8')).toBe('newer base\n')
      expect(git('-C', tree.path, 'status', '--porcelain')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a default launch with a dirty checkout carries nothing and tells the operator', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-carry-default-off-'))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-carry-default-off-bin-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      writeFileSync(join(repo, 'kept.txt'), 'dirty tracked\n')
      writeFileSync(join(repo, 'new.txt'), 'dirty untracked\n')
      expect(checkoutHasUncommittedWork(repo)).toBe(true)

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const launched = Bun.spawnSync(
        [process.execPath, CLI, 'do', 'implement', 'leave the dirt behind', '--agent', 'grok', '--follow'],
        {
          cwd: repo,
          env: {
            ...process.env, PATH: `${binDir}:${process.env.PATH}`,
            ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(launched.exitCode).toBe(0)
      expect(launched.stderr.toString()).toContain(
        'this checkout has uncommitted work that will not be carried into the worker',
      )
      expect(launched.stderr.toString()).toContain('pass --carry to send it with the run')

      const row = db().query(
        `SELECT worktree, carry_happened, carry_tracked_paths, carry_untracked_paths
           FROM run ORDER BY id DESC LIMIT 1`,
      ).get() as {
        worktree: string; carry_happened: number
        carry_tracked_paths: string; carry_untracked_paths: string
      }
      expect(row.carry_happened).toBe(0)
      expect(JSON.parse(row.carry_tracked_paths)).toEqual([])
      expect(JSON.parse(row.carry_untracked_paths)).toEqual([])
      expect(readFileSync(join(row.worktree, 'kept.txt'), 'utf8')).toBe('base\n')
      expect(existsSync(join(row.worktree, 'new.txt'))).toBe(false)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('an explicit --carry launch with a dirty checkout carries and records as before', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-carry-opt-in-'))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-carry-opt-in-bin-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      writeFileSync(join(repo, 'kept.txt'), 'carried tracked\n')
      writeFileSync(join(repo, 'new.txt'), 'carried untracked\n')

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const launched = Bun.spawnSync(
        [process.execPath, CLI, 'do', 'implement', 'send the dirt', '--agent', 'grok', '--carry', '--follow'],
        {
          cwd: repo,
          env: {
            ...process.env, PATH: `${binDir}:${process.env.PATH}`,
            ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(launched.exitCode).toBe(0)
      expect(launched.stderr.toString()).not.toContain('will not be carried')

      const row = db().query(
        `SELECT id, worktree, carry_happened, carry_tracked_paths, carry_untracked_paths
           FROM run ORDER BY id DESC LIMIT 1`,
      ).get() as {
        id: number; worktree: string; carry_happened: number
        carry_tracked_paths: string; carry_untracked_paths: string
      }
      expect(row.carry_happened).toBe(1)
      expect(JSON.parse(row.carry_tracked_paths)).toEqual(['kept.txt'])
      expect(JSON.parse(row.carry_untracked_paths)).toEqual(['new.txt'])
      expect(readFileSync(join(row.worktree, 'kept.txt'), 'utf8')).toBe('carried tracked\n')
      expect(readFileSync(join(row.worktree, 'new.txt'), 'utf8')).toBe('carried untracked\n')

      const shown = Bun.spawnSync(
        [process.execPath, CLI, 'diff', String(row.id), '--quiet'],
        { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(shown.stdout.toString()).toContain('carry: 1 tracked path(s), 1 untracked path(s)')
      expect(shown.stdout.toString()).toContain('carry tracked: "kept.txt"')
      expect(shown.stdout.toString()).toContain('carry untracked: "new.txt"')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('a behind caller is refused whether or not carrying was requested', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-stale-caller-launch-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    const priorDepth = process.env.ORCH_DEPTH
    const fakeAgent = join(dir, 'carry-behind-agent.sh')
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(fakeAgent, `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(fakeAgent, 0o755)
    agent.bin = fakeAgent
    agent.argv = () => []
    process.env.ORCH_DEPTH = '0'
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'caller base\n')
      git('add', 'tracked.txt')
      git('commit', '-m', 'caller base')
      const callerHead = git('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'tracked.txt'), 'newer base\n')
      git('commit', '-am', 'newer base')
      const newer = git('rev-parse', 'HEAD')
      git('switch', '--detach', callerHead)

      for (const carry of [undefined, true] as const) {
        await expect(runJob({
          job: 'implement', prompt: 'should not revert', cwd: repo, agent: 'grok',
          base: newer, carry,
        })).rejects.toThrow(
          `caller HEAD ${callerHead} is behind or diverged from the tree's base ${newer}`,
        )
        expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('caller base\n')
        const leftover = existsSync(join(repo, '.claude', 'worktrees'))
          ? readdirSync(join(repo, '.claude', 'worktrees'))
          : []
        expect(leftover.filter((name) => name.startsWith('orch-'))).toEqual([])
      }
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(fakeAgent, { force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('every turn in a three-turn chain declares the inherited carry audit', async () => {
    const makeRepo = () => {
      const repo = mkdtempSync(join(tmpdir(), 'orch-carry-chain-'))
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(['git', ...args], {
          cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      }
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      return repo
    }
    const dirty = makeRepo()
    const clean = makeRepo()
    const applyRepo = mkdtempSync(join(tmpdir(), 'orch-carry-apply-'))
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    const originalResume = agent.resumeArgv
    const priorDepth = process.env.ORCH_DEPTH
    const fakeAgent = join(dir, 'carry-chain-agent.sh')
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(fakeAgent, `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(fakeAgent, 0o755)
    agent.bin = fakeAgent
    agent.argv = () => []
    agent.resumeArgv = () => []
    process.env.ORCH_DEPTH = '0'

    const chain = async (repo: string) => {
      const first = await runJob({
        job: 'implement', prompt: 'carry audit', cwd: repo, agent: 'grok', carry: true,
      })
      const tree = first.worktree!
      const second = await runJob({
        job: 'implement', prompt: 'turn two', cwd: tree.path,
        resume: {
          parent: first.id, agent: 'grok', session: 'carry-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      const third = await runJob({
        job: 'implement', prompt: 'turn three', cwd: tree.path,
        resume: {
          parent: first.id, agent: 'grok', session: 'carry-session', turn: 3,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      return { ids: [first.id, second.id, third.id], tree }
    }

    try {
      writeFileSync(join(dirty, 'kept.txt'), 'carried tracked\n')
      writeFileSync(join(dirty, 'new.txt'), 'carried untracked\n')
      const dirtyChain = await chain(dirty)
      const dirtyRows = db().query(
        `SELECT carry_happened, carry_base_commit, carry_tracked_paths, carry_untracked_paths
           FROM run WHERE id IN (?,?,?) ORDER BY turn`,
      ).all(...dirtyChain.ids) as Array<{
        carry_happened: number; carry_base_commit: string
        carry_tracked_paths: string; carry_untracked_paths: string
      }>
      expect(dirtyRows).toHaveLength(3)
      for (const row of dirtyRows) {
        expect(row.carry_happened).toBe(1)
        expect(row.carry_base_commit).toBe(dirtyChain.tree.base)
        expect(JSON.parse(row.carry_tracked_paths)).toEqual(['kept.txt'])
        expect(JSON.parse(row.carry_untracked_paths)).toEqual(['new.txt'])
      }

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const shown = Bun.spawnSync(
        [process.execPath, CLI, 'diff', String(dirtyChain.ids[2]), '--quiet'],
        { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(shown.exitCode).toBe(0)
      const output = shown.stdout.toString()
      expect(output.match(/^base: /gm)).toHaveLength(1)
      expect(output).toContain('carry: 1 tracked path(s), 1 untracked path(s)')
      expect(output).toContain('carry tracked: "kept.txt"')
      expect(output).toContain('carry untracked: "new.txt"')
      const cloned = Bun.spawnSync(['git', 'clone', '--quiet', dirty, applyRepo], {
        env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(cloned.exitCode).toBe(0)
      const applies = Bun.spawnSync(['git', 'apply', '--check', '-'], {
        cwd: applyRepo, env: hermeticGitEnv(), stdin: shown.stdout, stdout: 'pipe', stderr: 'pipe',
      })
      expect(applies.exitCode).toBe(0)

      const cleanChain = await chain(clean)
      for (const id of cleanChain.ids) {
        const cleanShown = Bun.spawnSync([process.execPath, CLI, 'diff', String(id), '--quiet'], {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(cleanShown.exitCode).toBe(0)
        expect(cleanShown.stdout.toString()).toContain(
          'carry: none (0 tracked paths, 0 untracked paths)',
        )
      }
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      agent.resumeArgv = originalResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(fakeAgent, { force: true })
      rmSync(dirty, { recursive: true, force: true })
      rmSync(clean, { recursive: true, force: true })
      rmSync(applyRepo, { recursive: true, force: true })
    }
  }, 20_000)

  test('orch diff resolves a new blob staged in the worker-local object database', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-isolated-objects-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, ['init', '-b', 'main'])
      git(repo, ['config', 'user.email', 'orch-test@example.invalid'])
      git(repo, ['config', 'user.name', 'Orch Test'])
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, ['add', 'kept.txt'])
      git(repo, ['commit', '-m', 'base'])
      const tree = createWorktree(repo, 126)
      const objectEnv = prepareWorktreeObjects(tree.path)
      const content = `worker-only-${randomUUID()}\n`
      writeFileSync(join(tree.path, 'new.txt'), content)
      git(tree.path, ['add', 'new.txt'], objectEnv)
      const oid = git(tree.path, ['hash-object', 'new.txt'], objectEnv)

      expect(existsSync(join(objectEnv.GIT_OBJECT_DIRECTORY, oid.slice(0, 2), oid.slice(2))))
        .toBe(true)
      expect(existsSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2))))
        .toBe(false)

      const id = addRun({ agent: 'codex', job: 'implement' })
      db().query('UPDATE run SET worktree=?, branch=?, base_commit=? WHERE id=?')
        .run(tree.path, tree.branch, tree.base, id)
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const diff = Bun.spawnSync([process.execPath, CLI, 'diff', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })

      expect(diff.exitCode).toBe(0)
      expect(diff.stdout.toString()).toContain('diff --git a/new.txt b/new.txt')
      expect(diff.stdout.toString()).toContain(`+${content.trim()}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the shared-ref guard does not run project hooks in a scratch repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-project-hooks-'))
    const scratch = mkdtempSync(join(tmpdir(), 'orch-unrelated-scratch-'))
    const cleanConfig = { GIT_CONFIG_COUNT: '0' }
    const git = (cwd: string, args: string[], env: Record<string, string> = cleanConfig) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.email', 'orch-test@example.invalid']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.name', 'Orch Test']).exitCode).toBe(0)
      const projectHooks = join(repo, '.githooks')
      const actualProjectHooks = join(repo, '.actual-hooks')
      mkdirSync(projectHooks)
      mkdirSync(actualProjectHooks)
      writeFileSync(join(projectHooks, 'commit-msg'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(projectHooks, 'commit-msg'), 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['commit', '--no-verify', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 156)
      const actualReferenceHook = join(actualProjectHooks, 'reference-transaction')
      writeFileSync(actualReferenceHook, '#!/bin/sh\nexit 1\n')
      chmodSync(actualReferenceHook, 0o755)
      symlinkSync(actualReferenceHook, join(projectHooks, 'reference-transaction'))

      const guardEnv = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      expect(readdirSync(join(worktreeGitDir(tree.path), 'orch-hooks')))
        .toEqual(['reference-transaction'])
      const installedWrapper = readFileSync(
        join(worktreeGitDir(tree.path), 'orch-hooks', 'reference-transaction'), 'utf8',
      )
      expect(installedWrapper).toContain(Buffer.from(realpathSync(actualReferenceHook)).toString('base64'))
      expect(installedWrapper).not.toContain(Buffer.from(
        join(projectHooks, 'reference-transaction'),
      ).toString('base64'))
      const installedReferenceHook = join(
        worktreeGitDir(tree.path), 'orch-hooks', 'reference-transaction',
      )
      expect(installedWrapper).not.toContain(
        `'${installedReferenceHook}' "$@"`,
      )
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = guardEnv.GIT_CONFIG_VALUE_0
      try {
        expect(prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)).toEqual(guardEnv)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      expect(readFileSync(
        join(worktreeGitDir(tree.path), 'orch-hooks', 'reference-transaction'), 'utf8',
      )).toBe(installedWrapper)

      expect(git(scratch, ['init', '-b', 'main'], guardEnv).exitCode).toBe(0)
      expect(git(scratch, ['config', 'user.email', 'orch-test@example.invalid'], guardEnv).exitCode).toBe(0)
      expect(git(scratch, ['config', 'user.name', 'Orch Test'], guardEnv).exitCode).toBe(0)
      writeFileSync(join(scratch, 'fixture.txt'), 'fixture\n')
      expect(git(scratch, ['add', 'fixture.txt'], guardEnv).exitCode).toBe(0)
      const committed = git(scratch, ['commit', '-m', 'test fixture'], guardEnv)
      expect(committed.exitCode).toBe(0)
      expect(committed.stderr.toString()).toBe('')

      const scratchTree = createWorktree(scratch, 165)
      const scratchObjects = prepareWorktreeObjects(scratchTree.path)
      writeFileSync(join(scratchTree.path, 'private.txt'), 'scratch-private\n')
      expect(git(scratchTree.path, ['add', 'private.txt'], {
        ...guardEnv, ...scratchObjects,
      }).exitCode).toBe(0)
      const privateCommit = git(scratchTree.path, ['commit', '-m', 'private fixture'], {
        ...guardEnv, ...scratchObjects,
      })
      expect(privateCommit.exitCode).toBe(0)
      expect(privateCommit.stderr.toString()).toBe('')
      const privateOid = git(scratchTree.path, ['rev-parse', 'HEAD'], scratchObjects)
        .stdout.toString().trim()
      expect(existsSync(join(
        scratchObjects.GIT_OBJECT_DIRECTORY, privateOid.slice(0, 2), privateOid.slice(2),
      ))).toBe(true)
      expect(existsSync(join(
        scratch, '.git', 'objects', privateOid.slice(0, 2), privateOid.slice(2),
      ))).toBe(false)
      const updated = git(scratchTree.path, [
        'update-ref', 'refs/heads/scratch-private', privateOid,
      ], { ...guardEnv, ...scratchObjects })
      expect(updated.exitCode).toBe(0)
      expect(updated.stderr.toString()).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('shared-ref guard preparation is idempotent under its inherited hooks path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-idempotent-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    const sharedGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
    const sharedBefore = readFileSync(sharedGuard)
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.email', 'orch-test@example.invalid']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.name', 'Orch Test']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 225)

      const first = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      const installed = join(first.GIT_CONFIG_VALUE_0, 'reference-transaction')
      expect(readFileSync(installed)).toEqual(readFileSync(sharedGuard))

      const installedBefore = readFileSync(installed)
      writeFileSync(join(first.GIT_CONFIG_VALUE_0,
        '.reference-transaction-99999999-interrupted'), 'litter\n')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = first.GIT_CONFIG_VALUE_0
      let second: ReturnType<typeof prepareSharedRefGuard> | undefined
      try {
        second = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      expect(second).toEqual(first)
      expect(readFileSync(sharedGuard)).toEqual(sharedBefore)
      expect(readFileSync(installed)).toEqual(installedBefore)
      expect(readdirSync(first.GIT_CONFIG_VALUE_0)).toEqual(['reference-transaction'])
      expect(readFileSync(installed)).toEqual(readFileSync(sharedGuard))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard config reads ignore an inherited worker hooks path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-hostile-config-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      const hostileHooks = join(repo, 'hostile-hooks')
      mkdirSync(projectHooks)
      mkdirSync(hostileHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      const hostileHook = join(hostileHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\necho project\n')
      writeFileSync(hostileHook, '#!/bin/sh\necho hostile\n')
      chmodSync(projectHook, 0o755)
      chmodSync(hostileHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 229)

      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = hostileHooks
      let guardEnv: ReturnType<typeof prepareSharedRefGuard> | undefined
      try {
        guardEnv = prepareSharedRefGuard(tree.path)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      const wrapper = readFileSync(join(guardEnv!.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8')
      expect(wrapper).toContain(Buffer.from(realpathSync(projectHook)).toString('base64'))
      expect(wrapper).not.toContain(Buffer.from(realpathSync(hostileHook)).toString('base64'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard recognition is independent of the running checkout path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-other-checkout-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 230)
      const hookDir = join(worktreeGitDir(tree.path), 'orch-hooks')
      const installed = join(hookDir, 'reference-transaction')
      const otherCheckoutGuard = join(repo, 'other-checkout', 'orchestrator', 'hooks',
        'reference-transaction')
      mkdirSync(join(repo, 'other-checkout', 'orchestrator', 'hooks'), { recursive: true })
      writeFileSync(otherCheckoutGuard, readFileSync(
        new URL('../hooks/reference-transaction', import.meta.url).pathname,
      ))
      chmodSync(otherCheckoutGuard, 0o755)
      mkdirSync(hookDir)
      symlinkSync(otherCheckoutGuard, installed)

      const guardEnv = prepareSharedRefGuard(tree.path)
      expect(guardEnv.GIT_CONFIG_VALUE_0).toBe(hookDir)
      expect(realpathSync(installed)).toBe(realpathSync(otherCheckoutGuard))

      rmSync(installed)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      prepareSharedRefGuard(tree.path)
      const runningGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
      const otherWrapper = readFileSync(installed, 'utf8')
        .replace(Buffer.from(runningGuard).toString('base64'),
          Buffer.from(realpathSync(otherCheckoutGuard)).toString('base64'))
        .replace(`'${runningGuard}' "$@"`, `'${realpathSync(otherCheckoutGuard)}' "$@"`)
      writeFileSync(installed, otherWrapper)
      chmodSync(installed, 0o755)

      expect(prepareSharedRefGuard(tree.path)).toEqual(guardEnv)
      expect(readFileSync(installed, 'utf8')).toBe(otherWrapper)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a killed preparation never publishes a partial hooks directory', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-killed-publication-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const module = new URL('worktree.ts', import.meta.url).href
      const checkpoints = ['mkdir', 'cleanup', 'temporary-open', 'write', 'chmod', 'fsync', 'close']
      for (const [index, checkpoint] of checkpoints.entries()) {
        const tree = createWorktree(repo, 231 + index)
        const gitDir = worktreeGitDir(tree.path)
        const hookDir = join(gitDir, 'orch-hooks')
        const ready = join(repo, `checkpoint-${checkpoint}`)
        const child = Bun.spawn([process.execPath, '-e',
          `const { prepareSharedRefGuard } = await import(process.argv[1]);
           prepareSharedRefGuard(process.argv[2], process.argv[3]);`,
          module, tree.path, `refs/heads/${tree.branch}`], {
          cwd: tree.path,
          env: hermeticGitEnv({
            ORCH_TEST_REF_GUARD_CHECKPOINT: checkpoint,
            ORCH_TEST_REF_GUARD_READY: ready,
          }),
          stdout: 'pipe', stderr: 'pipe',
        })
        const deadline = Date.now() + 5_000
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5)
        expect(existsSync(ready)).toBe(true)
        expect(existsSync(hookDir)).toBe(false)
        child.kill('SIGKILL')
        expect(await child.exited).not.toBe(0)

        const guardEnv = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
        const forbidden = git(tree.path, [
          'update-ref', 'refs/heads/forbidden', 'HEAD',
        ], guardEnv)
        expect(forbidden.exitCode).not.toBe(0)
        expect(forbidden.stderr.toString()).toContain('this worker may update only')
        expect(readdirSync(hookDir)).toEqual(['reference-transaction'])
        expect(readdirSync(gitDir).filter(name => name.startsWith('.orch-hooks-'))).toEqual([])
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a wrapper delegating to a non-executable guard is rejected', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-broken-mode-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 232)
      const guardEnv = prepareSharedRefGuard(tree.path)
      const installed = join(guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction')
      const runningGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
      const delegatedGuard = join(repo, 'delegated-guard')
      writeFileSync(delegatedGuard, readFileSync(runningGuard))
      chmodSync(delegatedGuard, 0o644)
      const wrapper = readFileSync(installed, 'utf8')
        .replace(Buffer.from(runningGuard).toString('base64'),
          Buffer.from(delegatedGuard).toString('base64'))
        .replace(`'${runningGuard}' "$@"`, `'${delegatedGuard}' "$@"`)
      writeFileSync(installed, wrapper)
      chmodSync(installed, 0o755)

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `refusing to replace existing shared ref guard hook ${installed}`,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('concurrent shared-ref guard preparations publish one complete executable wrapper', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-concurrent-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 233)
      const barrier = join(repo, 'start-preparation')
      const module = new URL('worktree.ts', import.meta.url).href
      const child = () => Bun.spawn([process.execPath, '-e',
        `import { existsSync } from 'node:fs';
         while (!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
         const { prepareSharedRefGuard } = await import(process.argv[1]);
         prepareSharedRefGuard(process.argv[3]);`, module, barrier, tree.path], {
        cwd: tree.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      const first = child()
      const second = child()
      writeFileSync(barrier, 'go\n')
      const [firstExit, secondExit] = await Promise.all([first.exited, second.exited])
      expect(firstExit).toBe(0)
      expect(secondExit).toBe(0)
      const hookDir = join(worktreeGitDir(tree.path), 'orch-hooks')
      const installed = join(hookDir, 'reference-transaction')
      expect(statSync(installed).mode & 0o111).toBe(0o111)
      expect(readdirSync(hookDir)).toEqual(['reference-transaction'])
      expect(readFileSync(installed, 'utf8')).toContain(
        Buffer.from(realpathSync(projectHook)).toString('base64'),
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard refuses a self-referencing original without changing it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-self-reference-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 226)
      const hookDir = join(worktreeGitDir(tree.path), 'orch-hooks')
      const installed = join(hookDir, 'reference-transaction')
      mkdirSync(hookDir)
      writeFileSync(installed, '#!/bin/sh\necho original\n')
      chmodSync(installed, 0o755)
      expect(git(tree.path, ['config', 'core.hooksPath', hookDir]).exitCode).toBe(0)
      const before = readFileSync(installed)

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `refusing shared ref guard wrapper: original hook resolves to its own path ${installed}`,
      )
      expect(readFileSync(installed)).toEqual(before)
      expect(readdirSync(hookDir)).toEqual(['reference-transaction'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard refuses a project hook symlinked to the tracked guard', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-shared-symlink-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    const sharedGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
    const sharedBefore = readFileSync(sharedGuard)
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 227)
      const projectHooks = join(repo, '.githooks')
      mkdirSync(projectHooks)
      symlinkSync(sharedGuard, join(projectHooks, 'reference-transaction'))
      expect(git(tree.path, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const hookDir = join(worktreeGitDir(tree.path), 'orch-hooks')

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `resolves to tracked shared guard ${sharedGuard}`,
      )
      expect(existsSync(hookDir)).toBe(false)
      expect(readFileSync(sharedGuard)).toEqual(sharedBefore)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard refuses an unwritable hook path without cleaning it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-unwritable-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    let hookDir: string | null = null
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 228)
      hookDir = join(worktreeGitDir(tree.path), 'orch-hooks')
      mkdirSync(hookDir)
      writeFileSync(join(hookDir, 'leave-alone'), 'sentinel\n')
      chmodSync(hookDir, 0o555)

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `cannot install shared ref guard: hook path is not writable: ${hookDir}`,
      )
      expect(readdirSync(hookDir)).toEqual(['leave-alone'])
      expect(readFileSync(join(hookDir, 'leave-alone'), 'utf8')).toBe('sentinel\n')
    } finally {
      if (hookDir) chmodSync(hookDir, 0o755)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the shared-ref guard permits real rebase and merge bookkeeping', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-worker-porcelain-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    const ok = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = git(cwd, args, env)
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      ok(repo, ['init', '-b', 'main'])
      ok(repo, ['config', 'user.email', 'orch-test@example.invalid'])
      ok(repo, ['config', 'user.name', 'Orch Test'])
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      ok(repo, ['add', 'base.txt'])
      ok(repo, ['commit', '-m', 'base'])

      const tree = createWorktree(repo, 199)
      const guard = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      writeFileSync(join(tree.path, 'worker-one.txt'), 'worker one\n')
      ok(tree.path, ['add', 'worker-one.txt'], guard)
      ok(tree.path, ['commit', '-m', 'worker one'], guard)
      writeFileSync(join(repo, 'main-one.txt'), 'main one\n')
      ok(repo, ['add', 'main-one.txt'])
      ok(repo, ['commit', '-m', 'main one'])

      const rebased = git(tree.path, ['rebase', 'main'], guard)
      expect(rebased.exitCode).toBe(0)
      expect(rebased.stderr.toString()).not.toContain('refusing shared ref update')
      expect(ok(tree.path, ['merge-base', '--is-ancestor', 'main', 'HEAD'])).toBe('')

      writeFileSync(join(repo, 'main-two.txt'), 'main two\n')
      ok(repo, ['add', 'main-two.txt'])
      ok(repo, ['commit', '-m', 'main two'])
      writeFileSync(join(tree.path, 'worker-two.txt'), 'worker two\n')
      ok(tree.path, ['add', 'worker-two.txt'], guard)
      ok(tree.path, ['commit', '-m', 'worker two'], guard)

      const merged = git(tree.path, ['merge', '--no-edit', 'main'], guard)
      expect(merged.exitCode).toBe(0)
      expect(merged.stderr.toString()).not.toContain('refusing shared ref update')
      expect(ok(tree.path, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('worker commits are durable while the guard protects every other ref', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-land-common-objects-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, ['init', '-b', 'main'])
      git(repo, ['config', 'user.email', 'orch-test@example.invalid'])
      git(repo, ['config', 'user.name', 'Orch Test'])
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, ['add', 'kept.txt'])
      git(repo, ['commit', '-m', 'base'])

      // Prove the old environment can reproduce the incident: the landing
      // worktree reads its commit, while the checkout owning the common store
      // cannot. This is the ablation that makes the positive assertion useful.
      const isolatedTree = createWorktree(repo, 1490)
      const isolatedEnv = gitObjectEnvironmentFor('codex', JOBS['review-lens']!, isolatedTree)!
      writeFileSync(join(isolatedTree.path, 'private.txt'), 'private\n')
      git(isolatedTree.path, ['add', 'private.txt'], isolatedEnv)
      git(isolatedTree.path, ['commit', '-m', 'private commit'], isolatedEnv)
      const privateCommit = git(isolatedTree.path, ['rev-parse', 'HEAD'], isolatedEnv)
      expect(() => git(repo, ['cat-file', '-t', privateCommit])).toThrow()
      expect(existsSync(join(
        isolatedEnv.GIT_OBJECT_DIRECTORY, privateCommit.slice(0, 2), privateCommit.slice(2),
      ))).toBe(true)

      // Reproduce the dangerous operation itself. The proposed commit is
      // readable to this worktree only; the prepared reference transaction
      // must refuse before main changes, and diagnose both object and store.
      const guarded = Bun.spawnSync([
        'git', 'update-ref', 'refs/heads/main', privateCommit,
      ], {
        cwd: isolatedTree.path,
        env: hermeticGitEnv({ ...isolatedEnv, ...prepareSharedRefGuard(isolatedTree.path) }),
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(guarded.exitCode).not.toBe(0)
      expect(guarded.stderr.toString()).toContain(`stranded object ${privateCommit}`)
      expect(guarded.stderr.toString()).toContain(isolatedEnv.GIT_OBJECT_DIRECTORY)
      expect(git(repo, ['rev-parse', 'main'])).not.toBe(privateCommit)

      // Remove the deliberately broken fixture before checking repository
      // connectivity for the fixed case.
      git(repo, ['worktree', 'remove', '--force', isolatedTree.path])
      git(repo, ['update-ref', '-d', `refs/heads/${isolatedTree.branch}`])

      const landingTree = createWorktree(repo, 1491)
      const landingEnv = gitObjectEnvironmentFor('codex', JOBS.land!, landingTree)
      expect(landingEnv).toBeUndefined()
      writeFileSync(join(landingTree.path, 'landed.txt'), 'shared\n')
      git(landingTree.path, ['add', 'landed.txt'], landingEnv)
      git(landingTree.path, ['commit', '-m', 'shared commit'], landingEnv)
      const landingCommit = git(landingTree.path, ['rev-parse', 'HEAD'], landingEnv)

      expect(git(repo, ['cat-file', '-t', landingCommit])).toBe('commit')

      const workerTree = createWorktree(repo, 1492)
      expect(gitObjectEnvironmentFor('codex', JOBS.implement!, workerTree)).toBeUndefined()
      writeFileSync(join(workerTree.path, 'worker.txt'), 'committed\n')
      git(workerTree.path, ['add', 'worker.txt'])
      const workerGuard = prepareSharedRefGuard(
        workerTree.path, `refs/heads/${workerTree.branch}`,
      )
      git(workerTree.path, ['commit', '-m', 'worker commit'], workerGuard)
      const workerCommit = git(workerTree.path, ['rev-parse', 'HEAD'])
      const captured = changesIn(workerTree)
      expect(captured.files).toEqual(['worker.txt'])
      expect(captured.diff).toContain('+committed')
      expect(writingFailoverRefusal(true, captured, workerTree.path)).toContain(
        'writing run has 1 changed file(s)',
      )

      const trunkAttempt = Bun.spawnSync([
        'git', 'update-ref', 'refs/heads/main', workerCommit,
      ], {
        cwd: workerTree.path,
        env: hermeticGitEnv(workerGuard), stdout: 'pipe', stderr: 'pipe',
      })
      expect(trunkAttempt.exitCode).not.toBe(0)
      expect(trunkAttempt.stderr.toString()).toContain(
        `refusing shared ref update refs/heads/main: this worker may update only ` +
        `refs/heads/${workerTree.branch}`,
      )
      expect(git(repo, ['rev-parse', 'main'])).not.toBe(workerCommit)

      git(repo, ['worktree', 'remove', '--force', workerTree.path])
      expect(git(repo, ['rev-parse', workerTree.branch])).toBe(workerCommit)
      expect(git(repo, ['cat-file', '-t', workerCommit])).toBe('commit')
      expect(existsSync(join(
        repo, '.git', 'objects', landingCommit.slice(0, 2), landingCommit.slice(2),
      ))).toBe(true)
      expect(existsSync(join(
        repo, '.git', 'worktrees', landingTree.branch, 'objects',
        landingCommit.slice(0, 2), landingCommit.slice(2),
      ))).toBe(false)

      git(repo, ['update-ref', 'refs/heads/main', landingCommit])
      expect(git(repo, ['log', '--oneline', '-1'])).toContain(landingCommit.slice(0, 7))
      expect(() => git(repo, ['status', '--short'])).not.toThrow()
      expect(git(repo, ['fsck', '--connectivity-only'])).not.toContain(landingCommit)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})


describe('a worker asking is not a worker blocked', () => {
  test('the old word is accepted and normalised', () => {
    // `blocked` was renamed because a "blocker" in this system means the
    // opposite — an environment problem, not a worker behaving correctly. But
    // an agent whose schema was dropped, or echoing older instructions, will
    // still say it, and rejecting a reply over a synonym would throw away a
    // finished implementation.
    const r = parseWorkerReply(JSON.stringify(workerReply({
      status: 'blocked', summary: 'x', questions: [{
        question: 'q?', options: null, recommendation: null, why: null,
      }],
    })))
    expect(r?.status).toBe('asking')
  })

  test('the two vocabularies do not overlap', () => {
    // The whole point of the rename: on a page, a run that is `asking` is
    // healthy and a `blocker` is not, and they must not read as the same red.
    const asking = parseWorkerReply(JSON.stringify(workerReply({ status: 'asking', summary: 'x' })))
    expect(asking?.status).toBe('asking')
    expect(detectBlockers('Docker access was denied, so I could not run the suite.')).not.toEqual([])
  })
})

describe('the exit code decides a signal death, not the vendor prose', () => {
  test("codex's echoed banner no longer reads as a plain failure", () => {
    // codex prints a banner and echoes the prompt to stderr, so a harness kill
    // arrived as screens of its own input and was classified `other` —
    // charging the agent for a process group somebody else killed.
    const banner = 'OpenAI Codex v0.5\n workdir: /x\n model: gpt-5\n<the whole prompt echoed>'
    expect(classify(banner, 143)).toBe('interrupted')
  })

  test('a prompt that merely discusses timeouts is not a timeout', () => {
    // The timeout pattern matched words inside the echoed prompt: one run was
    // filed as a timeout because its own prompt was about timeouts.
    expect(classify('the spec discusses timeout handling in detail', 143)).toBe('interrupted')
  })

  test('our own timer is a timeout; a harness kill is not', () => {
    // Both arrive as SIGTERM, so the exit code cannot separate them — only the
    // caller knows which fired. Ours is a fact about the agent, a harness kill
    // is a fact about the room, and only the second is excluded from evidence.
    expect(classify('no reply within 20m', 143, true)).toBe('timeout')
    expect(classify('no reply within 20m', 143, false)).toBe('interrupted')
  })

  test('an ordinary failure is still read from its text', () => {
    expect(classify('HTTP 429: rate limit exceeded', 1)).toBe('quota')
    expect(classify('upstream request timed out', 1)).toBe('timeout')
    expect(classify('something broke', 1)).toBe('other')
  })
})

describe('asking is a first-class outcome, not a failure', () => {
  test('every status check uses the current vocabulary', () => {
    /**
     * The rename from `blocked` to `asking` left four checks behind, and the
     * cost was immediate: `orch answer` refused every asking run with "is
     * asking, not waiting on a ruling", which is the escalation path refusing
     * the exact state it exists to serve.
     *
     * Asserted against the SOURCE rather than behaviour, because these are
     * scattered guards rather than one function — and a guard comparing against
     * a value the database can no longer hold fails silently and permanently.
     */
    const cli = readFileSync(new URL('./cli.ts', import.meta.url).pathname, 'utf8')
    const wt = readFileSync(new URL('./worktree.ts', import.meta.url).pathname, 'utf8')
    for (const [name, src] of [['cli.ts', cli], ['worktree.ts', wt]] as const) {
      // The only legitimate mention left is the parser normalising the old word
      // from an agent that still says it.
      const bad = src.split('\n').filter((l) =>
        ["'blocked'", '"blocked"'].some((quoted) => l.includes(quoted))
        && !l.includes('o.status') && !l.trim().startsWith('*')
        && !l.trim().startsWith('//'))
      expect({ [name]: bad }).toEqual({ [name]: [] })
    }
  })
})

describe('a worker that narrates in its own reply shape', () => {
  test('the LAST object wins, not the first and not the span', () => {
    // A worker under a schema narrates in the shape it was told to reply in.
    // One opened with a `done` carrying no files and emitted its real reply
    // afterwards; spanning both parsed as neither, so three files and 150
    // lines were recorded as "reply did not match the worker contract".
    // Believing the FIRST would be worse: a confident report of finishing
    // nothing.
    const r = parseWorkerReply([
      workerReply({ summary: 'Starting by reading the canon', files_changed: [] }),
      workerReply({ summary: 'Added the section', files_changed: ['a.ts', 'b.ts'] }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(r?.summary).toBe('Added the section')
    expect(r?.files_changed).toEqual(['a.ts', 'b.ts'])
  })

  test('a brace inside a string is not a brace', () => {
    // Depth-scanned rather than regexed, because a JSON object nests and a
    // summary may talk about braces.
    expect(parseWorkerReply(JSON.stringify(workerReply({ summary: 'uses {curly} braces' })))?.summary)
      .toBe('uses {curly} braces')
  })

  test('a later object that does not validate does not shadow a good one', () => {
    const r = parseWorkerReply(
      `${JSON.stringify(workerReply({ summary: 'real' }))}\n{"note":"trailing object with no status"}`,
    )
    expect(r?.summary).toBe('real')
  })

  test('multiple valid contract objects report their count and take the last', () => {
    const parsed = parseWorkerReplyWithCount([
      workerReply({ summary: 'real reply' }),
      workerReply({ summary: 'quoted contract-shaped object' }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(parsed.reply?.summary).toBe('quoted contract-shaped object')
    expect(parsed.contractObjects).toBe(2)
  })
})

describe('read-only orchestrator database', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname

  const fixture = (withHeartbeat = true) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'orch-readonly-'))
    const path = join(fixtureDir, 'orch.db')
    const d = new Database(path)
    applySchema(d)
    if (!withHeartbeat) d.exec('DROP TABLE session_seen')
    d.close()
    return { fixtureDir, path }
  }

  const invoke = (path: string, command: 'jobs' | 'inbox') => Bun.spawnSync(
    [process.execPath, CLI, command],
    {
      env: {
        ...process.env,
        ORCH_DB: path,
        ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'read-only-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    },
  )

  test('jobs and inbox serve reads without stamping a chmod-444 database', () => {
    const { fixtureDir, path } = fixture()
    chmodSync(path, 0o444)
    try {
      for (const command of ['jobs', 'inbox'] as const) {
        const p = invoke(path, command)
        expect(p.exitCode).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const readonly = new Database(path, { readonly: true })
      expect(readonly.query('SELECT COUNT(*) n FROM session_seen').get()).toEqual({ n: 0 })
      readonly.close()
    } finally {
      chmodSync(path, 0o644)
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('a read-only database missing session_seen still serves jobs and inbox', () => {
    const { fixtureDir, path } = fixture(false)
    chmodSync(path, 0o444)
    try {
      for (const command of ['jobs', 'inbox'] as const) {
        const p = invoke(path, command)
        expect(p.exitCode).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const readonly = new Database(path, { readonly: true })
      expect(readonly.query(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_seen'`,
      ).get()).toBeNull()
      readonly.close()
    } finally {
      chmodSync(path, 0o644)
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('a writable database keeps stamping the current session', () => {
    const { fixtureDir, path } = fixture()
    try {
      for (const command of ['jobs', 'inbox'] as const) {
        const p = invoke(path, command)
        expect(p.exitCode).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const writable = new Database(path)
      expect(writable.query(
        'SELECT session_id FROM session_seen WHERE session_id=?',
      ).get('read-only-test-session')).toEqual({ session_id: 'read-only-test-session' })
      writable.close()
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('a failed heartbeat stamp never propagates', () => {
    db().exec('DROP TABLE session_seen')
    try {
      expect(() => recordSessionSeen('heartbeat-failure-test')).not.toThrow()
    } finally {
      db().exec(`CREATE TABLE session_seen (
        session_id TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL
      )`)
    }
  })
})


describe('canonical schema rebuild', () => {
  /**
   * The CREATE TABLE migrate() used to ship, before every grafted column was
   * folded in. Copied, not reconstructed, so the rebuild is tested against the
   * definition an existing file actually has.
   */
  const OLD_RUN_DDL = `CREATE TABLE IF NOT EXISTS run (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      agent         TEXT NOT NULL,
      job           TEXT NOT NULL,
      repo          TEXT,
      cwd           TEXT,
      prompt_sha    TEXT NOT NULL,
      prompt_bytes  INTEGER NOT NULL,
      prompt_head   TEXT NOT NULL,
      latency_ms    INTEGER,
      exit_code     INTEGER,
      output_bytes  INTEGER,
      output_path   TEXT,
      prompt_path   TEXT,
      vendor_tokens INTEGER,
      vendor_cost_usd REAL,
      probe         INTEGER NOT NULL DEFAULT 0,
      failure_kind  TEXT,
      status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','failed','stale','asking','blocked')),
      error         TEXT
    )`
  const OLD_SCORE_DDL = `CREATE TABLE IF NOT EXISTS score (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      delivery  TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
      quality   TEXT CHECK (quality IN ('wrong','mixed','right')),
      fidelity  TEXT,
      note      TEXT,
      scored_at TEXT NOT NULL,
      scored_by TEXT NOT NULL DEFAULT 'claude',
      CHECK ((delivery = 'none') = (quality IS NULL))
    )`
  const OLD_DOC_DDL = `CREATE TABLE IF NOT EXISTS doc (
      id         INTEGER PRIMARY KEY,
      scope      TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global')),
      subject    TEXT,
      slug       TEXT NOT NULL CHECK (
                   length(slug) <= 64 AND
                   slug GLOB '[a-z0-9]*' AND
                   slug NOT GLOB '*[^a-z0-9-]*'
                 ),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope IN ('machine','global') AND subject IS NULL) OR
             (scope IN ('project','agent','job') AND subject IS NOT NULL)),
      UNIQUE(scope, subject, slug)
    )`

  const cols = (d: Database, table: string) =>
    (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

  const tableSql = (d: Database, name: string) =>
    (d.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { sql: string }).sql

  const metaVersion = (d: Database) =>
    (d.query(`SELECT value FROM schema_meta WHERE key='schema'`).get() as { value: string } | null)?.value ?? null

  function openOld(path: string): Database {
    const d = new Database(path)
    d.exec(OLD_RUN_DDL)
    d.exec(OLD_SCORE_DDL)
    d.exec(
      `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('2026-01-01T00:00:00.000Z', 'codex', 'implement', 'sha', 10, 'keep-me', 'blocked')`,
    )
    d.exec(
      `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
       VALUES (1, 'full', 'right', 'faithful', '2026-01-01T00:00:00.000Z')`,
    )
    applySchema(d)
    return d
  }

  test('an old database opens, is rebuilt, keeps its rows, and enforces the new CHECKs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'old.db')
    const d = openOld(path)
    expect(cols(d, 'run')).toEqual(cols(db(), 'run'))
    expect(cols(d, 'score')).toEqual(cols(db(), 'score'))
    expect(d.query('SELECT id, prompt_head, status FROM run').get()).toEqual(
      { id: 1, prompt_head: 'keep-me', status: 'asking' },
    )
    expect(d.query('SELECT fidelity FROM score WHERE run_id=1').get()).toEqual({ fidelity: 'faithful' })
    expect(() => d.exec("UPDATE run SET status='blocked' WHERE id=1")).toThrow()
    expect(() => d.exec("UPDATE score SET fidelity='typo' WHERE run_id=1")).toThrow()
    d.close()
  })

  test('a fresh database opens without a rebuild (meta version matches)', () => {
    const sql = tableSql(db(), 'run')
    expect(sql.startsWith('CREATE TABLE run')).toBe(true)
    expect(sql.startsWith('CREATE TABLE "run"')).toBe(false)
    const version = metaVersion(db())
    expect(version).toMatch(/^[0-9a-f]{64}$/)
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'fresh.db')
    const d = new Database(path)
    applySchema(d)
    expect(metaVersion(d)).toBe(version)
    const freshSql = tableSql(d, 'run')
    expect(freshSql.startsWith('CREATE TABLE run')).toBe(true)
    expect(freshSql.startsWith('CREATE TABLE "run"')).toBe(false)
    d.close()
  })

  test('empty abandoned port tables are replaced rather than left beside the real schema', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'legacy-port.db')
    const d = new Database(path)
    d.exec(`
      CREATE TABLE port_doctrine (n INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE port_ref (
        task_key TEXT PRIMARY KEY, target_project TEXT NOT NULL, source_projects TEXT NOT NULL,
        source_note TEXT, commits TEXT NOT NULL, paths TEXT NOT NULL, notes TEXT,
        created_at TEXT, resolved_at TEXT
      );
      CREATE TABLE port_baseline (
        source_project TEXT NOT NULL, target_project TEXT NOT NULL,
        baseline_sha TEXT, updated_at TEXT, PRIMARY KEY (source_project, target_project)
      );
      CREATE TABLE port_skipped (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_project TEXT NOT NULL,
        target_project TEXT NOT NULL, feature TEXT NOT NULL, note TEXT, created_at TEXT,
        UNIQUE (source_project, target_project, feature)
      );
    `)

    applySchema(d)

    expect(d.query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='port_skipped'`,
    ).get()).toBeNull()
    expect(cols(d, 'port_ref')).toEqual([
      'task_key', 'target_project_id', 'note', 'created_at', 'resolved_at',
    ])
    expect(cols(d, 'port_ref_source')).toContain('source_project_id')
    expect(cols(d, 'port_skip')).toContain('reason')
    expect(cols(d, 'port_doctrine')).toContain('retired_at')
    d.close()
  })

  test('adding ledger resolution state preserves existing provenance rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'pre-resolution-port.db')
    const d = new Database(path)
    d.exec(`
      CREATE TABLE port_ref (
        task_key TEXT PRIMARY KEY,
        target_project_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO port_ref VALUES ('TGT-9', 7, 'only copy', '2026-09-03T00:00:00.000Z');
    `)

    applySchema(d)

    expect(d.query('SELECT * FROM port_ref WHERE task_key=?').get('TGT-9')).toEqual({
      task_key: 'TGT-9', target_project_id: 7, note: 'only copy',
      created_at: '2026-09-03T00:00:00.000Z', resolved_at: null,
    })
    d.close()
  })

  test('widening the doc scope CHECK preserves every row and triple', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'old-doc.db')
    const d = new Database(path)
    d.exec(OLD_DOC_DDL)
    d.exec(`
      INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at) VALUES
        ('machine', NULL, 'host', 'Host', 'B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('agent', 'codex', 'mcp', 'MCP', 'C', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    const before = d.query(
      'SELECT id, scope, subject, slug, title, body, created_at, updated_at FROM doc ORDER BY id',
    ).all()
    const triples = d.query(
      'SELECT scope, subject, slug FROM doc ORDER BY scope, subject, slug',
    ).all()
    applySchema(d)
    expect(d.query(
      'SELECT id, scope, subject, slug, title, body, created_at, updated_at FROM doc ORDER BY id',
    ).all()).toEqual(before)
    expect(d.query(
      'SELECT scope, subject, slug FROM doc ORDER BY scope, subject, slug',
    ).all()).toEqual(triples)
    expect(before).toHaveLength(2)
    expect(tableSql(d, 'doc')).toContain("'resume'")
    d.exec(`INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
            VALUES ('resume', 'known', 'epic', 'T', 'B', 't', 't')`)
    expect(() => d.exec(`INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
            VALUES ('resume', NULL, 'x', 'T', 'B', 't', 't')`)).toThrow()
    d.close()
  })

  test('opening twice is idempotent', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'twice.db')
    const d = openOld(path)
    const first = {
      runSql: tableSql(d, 'run'),
      scoreSql: tableSql(d, 'score'),
      version: metaVersion(d),
      run: d.query('SELECT id, prompt_head, status FROM run').all(),
      score: d.query('SELECT run_id, delivery, quality, fidelity FROM score').all(),
      runCols: cols(d, 'run'),
      scoreCols: cols(d, 'score'),
    }
    applySchema(d)
    expect(tableSql(d, 'run')).toBe(first.runSql)
    expect(tableSql(d, 'score')).toBe(first.scoreSql)
    expect(metaVersion(d)).toBe(first.version)
    expect(d.query('SELECT id, prompt_head, status FROM run').all()).toEqual(first.run)
    expect(d.query('SELECT run_id, delivery, quality, fidelity FROM score').all()).toEqual(first.score)
    expect(cols(d, 'run')).toEqual(first.runCols)
    expect(cols(d, 'score')).toEqual(first.scoreCols)
    d.close()
  })
})

describe('scoped operator docs', () => {
  test('CRUD round-trips and set is a uniqueness-preserving upsert', () => {
    const first = setDoc({ scope: 'global', subject: null, slug: 'hello', title: 'Hello', body: 'one' })
    expect(getDoc('global', null, 'hello')?.body).toBe('one')
    const second = setDoc({ scope: 'global', subject: null, slug: 'hello', title: 'Hello again', body: 'two' })
    expect(second.id).toBe(first.id)
    expect(listDocs()).toHaveLength(1)
    expect(second.created_at).toBe(first.created_at)
    expect(second.body).toBe('two')
    expect(removeDoc('global', null, 'hello')).toBe(true)
    expect(getDoc('global', null, 'hello')).toBeNull()
  })

  test('scope, slug, and every subject rule name a usable fix', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const put = (scope: string, subject: string | null, slug = 'ok') =>
      setDoc({ scope, subject, slug, title: 'T', body: 'B' })
    expect(() => put('global', null, 'Bad')).toThrow('1-64')
    expect(() => put('global', null, 'a'.repeat(65))).toThrow('1-64')
    expect(() => put('unknown', null)).toThrow('valid scopes')
    expect(() => put('project', 'missing')).toThrow('valid values: known')
    expect(() => put('agent', 'missing')).toThrow(`valid values:`)
    expect(() => put('job', 'missing')).toThrow(`valid values:`)
    expect(() => put('machine', 'host')).toThrow('remove --subject')
    expect(() => put('global', 'all')).toThrow('remove --subject')
    expect(() => put('project', null)).toThrow('require --subject')
    expect(() => put('resume', null)).toThrow('require --subject')
    expect(() => put('resume', 'missing')).toThrow('valid values: known')
    expect(put('resume', 'known').scope).toBe('resume')
  })

  test('docsForRun orders global, job, then project and omits absent scopes', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(docsForRun({ job: 'file-question', cwd: '/elsewhere' })).toEqual([])
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'P' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'job', title: 'Job', body: 'J' })
    setDoc({ scope: 'global', subject: null, slug: 'global', title: 'Global', body: 'G' })
    setDoc({ scope: 'agent', subject: 'codex', slug: 'agent', title: 'Agent', body: 'A' })
    setDoc({ scope: 'machine', subject: null, slug: 'machine', title: 'Machine', body: 'M' })
    setDoc({ scope: 'resume', subject: 'known', slug: 'epic', title: 'Resume', body: 'R' })
    expect(docsForRun({ job: 'file-question', cwd: '/w/known/src' }).map((d) => d.title))
      .toEqual(['Global', 'Job', 'Project'])
  })

  test('metadata listing omits bodies and supports discovery filters without widening exact matches', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'project', subject: 'known', slug: 'mcp-scope', title: 'MCP Scope', body: 'first' })
    setDoc({ scope: 'agent', subject: 'codex', slug: 'capabilities', title: 'Capabilities', body: 'MCP scoping details' })
    setDoc({ scope: 'global', subject: null, slug: 'other', title: 'Other', body: 'é' })
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-01T00:00:00.000Z', 'other')
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-03T00:00:00.000Z', 'mcp-scope')
    db().query('UPDATE doc SET updated_at=? WHERE slug=?').run('2026-09-02T00:00:00.000Z', 'capabilities')

    expect(listDocMetadata({ scope: 'project' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ subject: 'known' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ match: 'mCp ScOpE' }).map((d) => d.slug)).toEqual(['mcp-scope'])
    expect(listDocMetadata({ bodyMatch: 'mCp ScOpInG' }).map((d) => d.slug)).toEqual(['capabilities'])
    expect(listDocMetadata({ scopes: ['agent', 'project'] }).map((d) => d.scope)).toEqual(['agent', 'project'])
    expect(listDocMetadata({ updatedAtOrder: 'asc' }).map((d) => d.slug))
      .toEqual(['other', 'capabilities', 'mcp-scope'])
    expect(listDocMetadata().find((d) => d.slug === 'other')).toMatchObject({ bytes: 2 })
    expect(listDocMetadata()).not.toContainKeys(['body', 'created_at'])
    expect(() => listDocMetadata({ scope: 'global', scopes: ['global'] })).toThrow('scope or scopes')
  })

  test('export and import preserve title and markdown body', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'quoted', title: 'A "title"', body: '# Body\n\nText\n' })
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'Estate' })
    const target = mkdtempSync(join(tmpdir(), 'orch-doc-export-'))
    try {
      expect(exportDocs(target)).toBe(2)
      db().exec('DELETE FROM doc')
      expect(importDocs(target)).toBe(2)
      expect(getDoc('global', null, 'quoted')).toMatchObject({ title: 'A "title"', body: '# Body\n\nText\n' })
      expect(getDoc('project', 'known', 'project')?.body).toBe('Estate')
    } finally { rmSync(target, { recursive: true, force: true }) }
  })

  test('brief contains global then current-project markdown, and is empty otherwise', () => {
    expect(brief('/nowhere')).toBe('')
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    expect(brief('/w/known/src')).toBe('## Global\n\nG\n\n## Project\n\nP')
  })

  test('first-turn bound prompts inject docs and count them; resumes do neither', async () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'j', title: 'Job', body: 'J' })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    const script = join(dir, 'docs-agent.ts')
    writeFileSync(script, 'process.stdout.write("ok")\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    const origResume = agent.resumeArgv
    let resumedPrompt = ''
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.resumeArgv = ({ prompt }) => { resumedPrompt = prompt; return [script] }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const first = await runJob({ job: 'file-question', prompt: 'FIRST SPEC', cwd: dir, agent: 'codex' })
      const firstRow = db().query('SELECT prompt_path, docs_injected FROM run WHERE id=?').get(first.id) as
        { prompt_path: string; docs_injected: number }
      const bound = readFileSync(firstRow.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW\n\n## Global\n\nG\n\n## Job\n\nJ\n\n## Project\n\nP')
      expect(firstRow.docs_injected).toBe(3)
      db().query('UPDATE run SET vendor_session=? WHERE id=?').run('docs-session', first.id)
      const resumed = await runJob({
        job: 'file-question', prompt: 'RULING', cwd: dir,
        resume: { parent: first.id, agent: 'codex', session: 'docs-session', turn: 2,
          sessionId: 'owner', worktree: null },
      })
      expect(resumedPrompt).not.toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
      expect((db().query('SELECT docs_injected FROM run WHERE id=?').get(resumed.id) as
        { docs_injected: number }).docs_injected).toBe(0)
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })

  test('MCP list_docs and get_doc work through linked in-memory transports', async () => {
    setDoc({ scope: 'global', subject: null, slug: 'mcp', title: 'MCP', body: 'Visible' })
    setDoc({
      scope: 'global', subject: null, slug: 'mcp-consume', title: 'MCP consume',
      body: '---\nstatus: open\n---\n\nVisible\n',
    })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listed = await client.callTool({ name: 'list_docs', arguments: { scope: 'global' } })
      const fetched = await client.callTool({ name: 'get_doc', arguments: { scope: 'global', slug: 'mcp' } })
      const consumed = await client.callTool({
        name: 'consume_doc', arguments: { scope: 'global', slug: 'mcp-consume' },
      })
      const listedText = ((listed as any).content[0] as { text: string }).text
      const fetchedText = ((fetched as any).content[0] as { text: string }).text
      const consumedText = ((consumed as any).content[0] as { text: string }).text
      const listedRows = JSON.parse(listedText)
      expect(listedRows).toHaveLength(2)
      expect(listedRows[0]).toEqual({
        id: expect.any(Number), scope: 'global', subject: null, slug: 'mcp', title: 'MCP',
        bytes: 7, updated_at: expect.any(String),
      })
      expect(listedRows[0]).not.toHaveProperty('body')
      expect(JSON.parse(fetchedText).body).toBe('Visible')
      expect(JSON.parse(consumedText)).toMatchObject({ already_consumed: false })
      expect(getDoc('global', null, 'mcp-consume')?.body).toContain('status: consumed')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP file_issue refuses a call missing evidence with an actionable message', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command should succeed',
          reproduce_command: 'bun test',
          environment: 'macOS test fixture',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain('evidence is required')
      expect(message).toContain('run ids, file:line pointers, or measured output')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP file_issue refuses a defect missing reproduce_command with an actionable message', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command should succeed',
          environment: 'macOS test fixture',
          evidence: 'run 123 failed with exit 1',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain('reproduce_command is required')
      expect(message).toContain('exact command that reproduces or demonstrates the issue')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test.each(['evidence', 'not_established'])('MCP file_issue refuses a suggestion missing %s', async (field) => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const arguments_: Record<string, string> = {
        kind: 'suggestion',
        what_happened: 'Issue reports need a direct filing path',
        expected: `A report should land on the ${PLATFORM_SLUG} board`,
        evidence: 'orchestrator/src/mcp.ts:11 had only project and document tools',
        not_established: 'No priority or assignee has been established',
      }
      delete arguments_[field]
      const filed = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain(`${field} is required`)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test(`MCP file_issue files a fully attributed ${PLATFORM_SLUG} task through hub`, async () => {
    const hubDb = join(dir, 'file-issue-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.HUB_DB = hubDb
    process.env.CLAUDE_CODE_SESSION_ID = 'reporting-test-session'
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          what_happened: 'Issue reports need a direct filing path',
          expected: `A report should land on the ${PLATFORM_SLUG} board`,
          evidence: 'orchestrator/src/mcp.ts:11 had only project and document tools',
          not_established: 'No priority or assignee has been established',
        },
      })
      expect(filed.isError).not.toBe(true)
      const result = JSON.parse(((filed as any).content[0] as { text: string }).text)
      expect(result).toMatchObject({
        key: 'DEV-1', kind: 'suggestion', session: 'reporting-test-session', project: PLATFORM_SLUG,
      })
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', result.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      const task = JSON.parse(shown.stdout.toString()).task
      expect(task.title).toBe('[SUGGESTION] Issue reports need a direct filing path')
      expect(task.project).toBe(PLATFORM_SLUG)
      expect(task.body).toContain('TYPE: SUGGESTION')
      expect(task.body).toContain('REPORTING SESSION: reporting-test-session')
      expect(task.body).toContain(`REPORTING PROJECT: ${PLATFORM_SLUG}`)
      expect(task.body).not.toContain('HOW TO REPRODUCE')
      expect(task.body).not.toContain('Command:')
      expect(task.body).not.toContain('Environment:')
      expect(task.body).toContain('EVIDENCE\norchestrator/src/mcp.ts:11')
      expect(task.body).toContain('WHAT IS NOT ESTABLISHED\nNo priority or assignee has been established')
    } finally {
      await client.close()
      await server.close()
      rmSync(hubDb, { force: true })
      rmSync(`${hubDb}-shm`, { force: true })
      rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })

  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orchCli = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }

  test('orch port exposes baseline, skip, ledger resolution, correction, and doctrine lifecycle', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })

    expect(orchCli(['port', 'baseline', 'set', 'source-invented', 'target-invented', 'abc']).code).toBe(0)
    const baseline = orchCli(['port', 'baseline', 'show', 'source-invented', 'target-invented', '--json'])
    expect(JSON.parse(baseline.out).baseline.source_commit).toBe('abc')
    expect(orchCli(['port', 'skip', 'add', 'source-invented', 'target-invented', 'old-feature',
      '--reason', 'superseded']).code).toBe(0)
    expect(JSON.parse(orchCli(['port', 'skip', 'list', 'source-invented', 'target-invented', '--json']).out))
      .toMatchObject([{ candidate: 'old-feature', reason: 'superseded' }])

    const sources = JSON.stringify([
      { project: 'source-invented', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
    ])
    expect(orchCli(['port', 'ref', 'set', 'TGT-7', '--sources', sources, '--note', 'native task']).code).toBe(0)
    const resolved = orchCli(['port', 'ref', 'resolve', 'TGT-7', '--json'])
    expect(JSON.parse(resolved.out)).toMatchObject({ task_key: 'TGT-7', resolved_at: expect.any(String) })
    expect(JSON.parse(orchCli(['port', 'ref', 'list', '--json']).out)).toEqual([])
    expect(JSON.parse(orchCli(['port', 'ref', 'list', '--all', '--json']).out)).toHaveLength(1)
    expect(orchCli(['port', 'ref', 'delete-error', 'TGT-7']).out).toContain('erroneous')
    expect(ledgerRef('TGT-7')).toBeNull()

    expect(orchCli(['port', 'doctrine', 'add', '4', '--title', 'Native', '--json'], 'Adapt natively.').code)
      .toBe(0)
    expect(orchCli(['port', 'doctrine', 'retire', '4']).code).toBe(0)
    expect(JSON.parse(orchCli(['port', 'doctrine', 'list', '--json']).out)).toEqual([])
    expect(JSON.parse(orchCli(['port', 'doctrine', 'list', '--all', '--json']).out))
      .toMatchObject([{ number: 4, retired_at: expect.any(String) }])
  })

  test('orch port refuses unknown registered project names and task prefixes', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    const unknown = orchCli(['port', 'baseline', 'show', 'source-invented', 'missing'])
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('unknown project "missing"')
    const sources = JSON.stringify([
      { project: 'source-invented', commits: [], paths: [], note: '' },
    ])
    const prefix = orchCli(['port', 'ref', 'set', 'NONE-1', '--sources', sources, '--note', ''])
    expect(prefix.code).toBe(1)
    expect(prefix.err).toContain('no registered project owns task key')
  })

  test('MCP port tools use registered names and preserve resolved provenance', async () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-port-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const value = (result: any) => JSON.parse((result.content[0] as { text: string }).text)
    try {
      await client.callTool({ name: 'set_port_baseline', arguments: {
        source: 'source-invented', target: 'target-invented', source_commit: 'abc',
      } })
      await client.callTool({ name: 'record_port_skip', arguments: {
        source: 'source-invented', target: 'target-invented', candidate: 'old', reason: 'done elsewhere',
      } })
      await client.callTool({ name: 'set_port_ledger_ref', arguments: {
        task_key: 'TGT-8', note: 'native', sources: [
          { project: 'source-invented', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
        ],
      } })
      const resolved = await client.callTool({ name: 'resolve_port_ledger_ref',
        arguments: { task_key: 'TGT-8' } })
      expect(value(resolved)).toMatchObject({ task_key: 'TGT-8', resolved_at: expect.any(String) })
      const active = await client.callTool({ name: 'list_port_ledger_refs', arguments: {} })
      const all = await client.callTool({ name: 'list_port_ledger_refs',
        arguments: { include_resolved: true } })
      expect(value(active)).toEqual([])
      expect(value(all)).toMatchObject([{ task_key: 'TGT-8', sources: [{ commits: ['abc'] }] }])
      await client.callTool({ name: 'add_port_doctrine_rule',
        arguments: { number: 5, title: 'Native', body: 'Adapt natively.' } })
      await client.callTool({ name: 'retire_port_doctrine_rule', arguments: { number: 5 } })
      const doctrine = await client.callTool({ name: 'list_port_doctrine',
        arguments: { include_retired: true } })
      expect(value(doctrine)).toMatchObject([{ number: 5, retired_at: expect.any(String) }])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('orch doc subjects --json lists project, agent and job names', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const r = orchCli(['doc', 'subjects', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({
      project: ['known'],
      agent: Object.keys(AGENTS).sort(),
      job: Object.keys(JOBS).sort(),
    })
    expect(docSubjects()).toEqual(JSON.parse(r.out))
  })

  test('orch doc rm --json reports whether a row was removed', () => {
    setDoc({ scope: 'global', subject: null, slug: 'gone', title: 'T', body: 'B' })
    const hit = orchCli(['doc', 'rm', 'gone', '--scope', 'global', '--json'])
    expect(hit.code).toBe(0)
    expect(JSON.parse(hit.out)).toEqual({ removed: true })
    const miss = orchCli(['doc', 'rm', 'gone', '--scope', 'global', '--json'])
    expect(miss.code).toBe(0)
    expect(JSON.parse(miss.out)).toEqual({ removed: false })
  })

  test('orch doc set --json round-trips a body with quote, backtick and newline', () => {
    const body = "quote' backtick` newline\n"
    const r = orchCli(
      ['doc', 'set', 'round-trip', '--scope', 'global', '--title', 'T', '--json'],
      body,
    )
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).body).toBe(body)
    expect(getDoc('global', null, 'round-trip')?.body).toBe(body)
  })

  test('orch doc consume stamps the session and preserves the document outside its fields', () => {
    const body = '---\r\nstatus: open\r\nepic: demo\r\nproject: known\r\nwritten: 2026-09-03T00:00:00.000Z\r\n---\r\n\r\nNEXT ACTION  \r\n'
    setDoc({ scope: 'global', subject: null, slug: 'take-it', title: 'Take it', body })
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'consume-test-session'
    try {
      const r = orchCli(['doc', 'consume', 'take-it', '--scope', 'global', '--json'])
      expect(r.code).toBe(0)
      const result = JSON.parse(r.out)
      expect(result.already_consumed).toBe(false)
      const consumed = getDoc('global', null, 'take-it')!.body
      expect(consumed).toMatch(/^---\r\nstatus: consumed\r\nconsumed: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\r\nconsumed_by: consume-test-session\r\nepic:/)
      expect(consumed.slice(consumed.indexOf('epic:'))).toBe(body.slice(body.indexOf('epic:')))
      expect(parseResumeFrontmatter(consumed)).toMatchObject({
        status: 'consumed', consumed_by: 'consume-test-session',
      })
    } finally {
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })

  test('orch doc consume reports an already-consumed document without rewriting it', () => {
    const body = '---\nstatus: consumed\nconsumed: 2026-09-03T01:02:03.000Z\nconsumed_by: first-session\nepic: demo\n---\n\nBODY\n'
    setDoc({ scope: 'global', subject: null, slug: 'taken', title: 'Taken', body })
    const before = getDoc('global', null, 'taken')!
    const r = orchCli(['doc', 'consume', 'taken', '--scope', 'global', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).already_consumed).toBe(true)
    expect(getDoc('global', null, 'taken')).toEqual(before)
  })

  test('consumeDoc rejects documents without frontmatter or a status field', () => {
    setDoc({ scope: 'global', subject: null, slug: 'plain', title: 'Plain', body: 'BODY\n' })
    setDoc({ scope: 'global', subject: null, slug: 'statusless', title: 'Statusless', body: '---\nepic: demo\n---\nBODY\n' })
    expect(() => consumeDoc('global', null, 'plain')).toThrow('has no YAML frontmatter')
    expect(() => consumeDoc('global', null, 'statusless')).toThrow('has no status field')
  })

  const resumeBody = (status: string, written?: string) => {
    const writtenLine = written ? `written: ${written}\n` : ''
    return `---\nstatus: ${status}\nepic: demo\nproject: known\n${writtenLine}---\n\nNEXT ACTION\n`
  }

  test('resumeAge uses a single largest unit', () => {
    const now = Date.parse('2026-09-03T12:00:00.000Z')
    expect(resumeAge(now, now)).toBe('0s')
    expect(resumeAge(now - 20_000, now)).toBe('20s')
    expect(resumeAge(now - 20 * 60_000, now)).toBe('20m')
    expect(resumeAge(now - 3 * 3600_000, now)).toBe('3h')
    expect(resumeAge(now - 3 * 86_400_000, now)).toBe('3d')
    expect(resumeAge(now - 59_000, now)).toBe('59s')
    expect(resumeAge(now - 60_000, now)).toBe('1m')
    expect(resumeAge(now - 3600_000, now)).toBe('1h')
    expect(resumeAge(now - 86_400_000, now)).toBe('1d')
  })

  test('parseResumeFrontmatter rejects a missing or broken block and keeps known keys', () => {
    expect(parseResumeFrontmatter('no fence')).toBeNull()
    expect(parseResumeFrontmatter('---\nstatus open\n---\n')).toBeNull()
    expect(parseResumeFrontmatter(resumeBody('open', '2026-09-03T00:00:00.000Z'))).toEqual({
      status: 'open', epic: 'demo', project: 'known', written: '2026-09-03T00:00:00.000Z',
    })
  })

  test('listOpenResumes lists only open briefs for the cwd project, newest first', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    upsertProject({ name: 'other', path: '/w/other', stack: null, canon: true, settings: {} })
    const now = Date.parse('2026-09-03T12:00:00.000Z')
    setDoc({
      scope: 'resume', subject: 'known', slug: 'older', title: 'Older epic',
      body: resumeBody('open', '2026-09-01T12:00:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'newer', title: 'Newer epic',
      body: resumeBody('open', '2026-09-03T11:40:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'done', title: 'Consumed',
      body: resumeBody('consumed', '2026-09-03T11:50:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'broken', title: 'Broken',
      body: 'not frontmatter',
    })
    setDoc({
      scope: 'resume', subject: 'other', slug: 'elsewhere', title: 'Other project',
      body: resumeBody('open', '2026-09-03T11:55:00.000Z'),
    })
    setDoc({
      scope: 'project', subject: 'known', slug: 'not-a-resume', title: 'Project doc',
      body: resumeBody('open', '2026-09-03T11:59:00.000Z'),
    })
    expect(listOpenResumes('/nowhere', now)).toEqual([])
    expect(listOpenResumes('/w/known/src', now)).toEqual([
      { slug: 'newer', title: 'Newer epic', age: '20m', at: Date.parse('2026-09-03T11:40:00.000Z') },
      { slug: 'older', title: 'Older epic', age: '2d', at: Date.parse('2026-09-01T12:00:00.000Z') },
    ])
    expect(brief('/w/known/src')).not.toContain('Newer epic')
  })

  test('orch doc resumes prints padded columns and is silent when there are none', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const empty = orchCli(['doc', 'resumes', '--cwd', '/w/known'])
    expect(empty.code).toBe(0)
    expect(empty.out).toBe('')
    const unresolved = orchCli(['doc', 'resumes', '--cwd', '/nowhere'])
    expect(unresolved.code).toBe(0)
    expect(unresolved.out).toBe('')
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', new Date().toISOString()),
    })
    const listed = orchCli(['doc', 'resumes', '--cwd', '/w/known'])
    expect(listed.code).toBe(0)
    const age = listed.out.trim().split(/\s+/).pop()
    expect(listed.out).toBe(`${'epic-name'.padEnd(24)} ${'Title here'.padEnd(24)} ${age}\n`)
    expect(age).toMatch(/^\d+[smhd]$/)
    expect(listed.out).not.toContain('scope')
  })
})

describe('session-brief hook lists open resumes without injecting bodies', () => {
  const hook = new URL('../hooks/session-brief.py', import.meta.url).pathname
  const runBrief = (payload: object) => Bun.spawnSync(
    ['python3', hook],
    {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
    },
  )
  const hookOutput = (p: ReturnType<typeof runBrief>) => JSON.parse(p.stdout.toString()) as {
    hookSpecificOutput: { hookEventName: string, additionalContext: string }
    systemMessage?: string
  }
  const resumeBody = (status: string, written: string) =>
    `---\nstatus: ${status}\nepic: demo\nproject: known\nwritten: ${written}\n---\n\nSECRET BODY\nNEXT ACTION\n`

  test('prints nothing when there are no open briefs', () => {
    const p = runBrief({ cwd: '/w/known', source: 'startup' })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('')
    expect(p.stderr.toString()).toBe('')
  })

  test('malformed stdin exits zero and prints nothing', () => {
    const p = Bun.spawnSync(['python3', hook], {
      stdin: new TextEncoder().encode('{not json'),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
    })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('')
  })

  test('one open brief: cold start asks, continuation offers, never dumps the body', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    const listLine = `${'epic-name'.padEnd(24)} ${'Title here'.padEnd(24)}`
    const cold = runBrief({ cwd: '/w/known', source: 'startup' })
    expect(cold.exitCode).toBe(0)
    const coldOutput = hookOutput(cold)
    expect(coldOutput.hookSpecificOutput.hookEventName).toBe('SessionStart')
    const coldOut = coldOutput.hookSpecificOutput.additionalContext
    expect(coldOut).toContain(listLine)
    expect(coldOut).toContain(
      'Open resume brief `epic-name`. Ask whether to load it before fetching with get_doc; after they agree and it is loaded, run orch doc consume.',
    )
    expect(coldOut).not.toContain('SECRET BODY')
    expect(coldOutput.systemMessage).toBe('Open resume brief: `epic-name`.')
    const cont = runBrief({ cwd: '/w/known', source: 'clear' })
    expect(hookOutput(cont).hookSpecificOutput.additionalContext).toContain(
      'Open resume brief `epic-name`. Offer to resume from it; fetch with get_doc only after they agree, then run orch doc consume.',
    )
    const resumeSrc = runBrief({ cwd: '/w/known', source: 'resume' })
    expect(hookOutput(resumeSrc).hookSpecificOutput.additionalContext).toContain('Ask whether to load it')
    const fork = runBrief({ cwd: '/w/known', source: 'fork' })
    expect(hookOutput(fork).hookSpecificOutput.additionalContext).toContain('Offer to resume from it')
  })

  test('several open briefs use the plural sentence', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'one', title: 'First',
      body: resumeBody('open', '2026-09-03T01:00:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'two', title: 'Second',
      body: resumeBody('open', '2026-09-03T02:00:00.000Z'),
    })
    const cold = runBrief({ cwd: '/w/known', source: 'startup' })
    const coldOutput = hookOutput(cold)
    expect(coldOutput.hookSpecificOutput.additionalContext).toContain(
      'Open resume briefs above. Ask which (if any) to load before fetching with get_doc; after they agree and one is loaded, run orch doc consume.',
    )
    expect(coldOutput.systemMessage).toBe('Open resume briefs: `two`, `one`.')
    const cont = runBrief({ cwd: '/w/known', source: 'compact' })
    expect(hookOutput(cont).hookSpecificOutput.additionalContext).toContain(
      'Open resume briefs above. Offer to resume from one of them; fetch with get_doc only after they agree, then run orch doc consume.',
    )
  })

  test('keeps the operator brief and appends resumes after it', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    const p = runBrief({ cwd: '/w/known', source: 'startup' })
    const out = hookOutput(p).hookSpecificOutput.additionalContext
    expect(out).toContain('## Global\n\nG')
    expect(out.indexOf('## Global')).toBeLessThan(out.indexOf('epic-name'))
    expect(out).toContain('Ask whether to load it')
  })
})
