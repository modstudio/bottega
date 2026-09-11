/**
 * Seeded lifecycle concurrency harness (DEV-321).
 *
 * Refusal contract for chunk 3 (each clause is a complete line):
 *   invariant: <the invariant's bolded phrase from orchestrator/AGENTS.md>
 *   cleared by: <a literal orch, git, or residue-removal invocation>
 *
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scrubbedGitEnv } from '../../../shared/git.ts'

const fixtureGlobal = globalThis as typeof globalThis & {
  __orchLifecycleFixture?: string
  __orchLifecycleBase?: string
}
const firstEvaluation = fixtureGlobal.__orchLifecycleFixture === undefined
const fixture = fixtureGlobal.__orchLifecycleFixture ??
  mkdtempSync(join(tmpdir(), 'orch-lifecycle-harness-'))
fixtureGlobal.__orchLifecycleFixture = fixture
const originalHome = process.env.HOME
const originalPath = process.env.PATH
const originalOrchEnv = Object.fromEntries(
  ['ORCH_DB', 'ORCH_RUNS', 'ORCH_DEPTH', 'CLAUDE_CODE_SESSION_ID']
    .map((name) => [name, process.env[name]]),
)
const storePath = process.env.ORCH_DB!
const runsPath = process.env.ORCH_RUNS!
const home = join(fixture, 'home')
const bin = join(fixture, 'bin')
const repoPath = join(fixture, 'trunk')
const timelines = join(fixture, 'timelines')
const violationsFile = join(fixture, 'violations.jsonl')
mkdirSync(home, { recursive: true })
mkdirSync(bin, { recursive: true })
mkdirSync(repoPath, { recursive: true })
mkdirSync(timelines, { recursive: true })
rmSync(violationsFile, { force: true })
const repo = realpathSync(repoPath)
writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
chmodSync(join(bin, 'docker'), 0o755)

process.env.HOME = home
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
process.env.ORCH_DEPTH = '0'
process.env.CLAUDE_CODE_SESSION_ID = 'lifecycle-harness'

const sourceRoot = join(dirname(new URL(import.meta.url).pathname), '../../..')
const cli = join(sourceRoot, 'orchestrator', 'src', 'cli.ts')
const worktreeModule = new URL('../../src/worktree.ts', import.meta.url).href
const dispatchPreflightModule = new URL('../../src/dispatch-preflight.ts', import.meta.url).href

const gitEnv = (extra: Record<string, string> = {}) => ({
  ...scrubbedGitEnv(),
  HOME: home,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  ...extra,
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: gitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

if (firstEvaluation) {
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'lifecycle@example.invalid')
  git(repo, 'config', 'user.name', 'Lifecycle Harness')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, 'commit', '-m', 'DEV-321 lifecycle fixture')
}
if (firstEvaluation) fixtureGlobal.__orchLifecycleBase = git(repo, 'rev-parse', 'HEAD')
const fixtureBase = fixtureGlobal.__orchLifecycleBase!
function store<T>(action: (database: Database) => T): T {
  const database = new Database(storePath)
  try { return action(database) } finally { database.close() }
}

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  for (const [name, value] of Object.entries(originalOrchEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(fixture, { recursive: true, force: true })
})

const defaultSeed = Number(process.env.ORCH_HARNESS_SEED ?? '1') >>> 0
const rounds = Math.max(1, Number(process.env.ORCH_HARNESS_ROUNDS ?? '3'))
const invariantLine = /^invariant: .+$/m
const clearingLine = /^cleared by: (?:orch|git|rmdir) .+$/m

const refusalCaseName = (site: string) =>
  `Every refusal names the invariant it protects and the command that clears it: ${site}`
const caseName = {
  migration: 'Only the main checkout binary migrates the store',
  linkedRefusal: refusalCaseName('linked-worktree write boundary'),
}

function expectationError(error: unknown): error is Error {
  return error instanceof Error && (
    /\n\s+at to[A-Z]\w* \(unknown\)/.test(error.stack ?? '') ||
    (/\bExpected\b/.test(error.message) && /\bReceived\b/.test(error.message))
  )
}

function violation(caseName: string, seed: string, check: () => void): void {
  try {
    check()
  } catch (error) {
    if (!expectationError(error)) throw error
    writeFileSync(violationsFile, `${JSON.stringify({
      case: caseName, at: new Date().toISOString(), seed: defaultSeed,
      evidence: `${seed}\n${error.message}`,
    })}\n`, { flag: 'a' })
    throw error
  }
}

class XorShift32 {
  constructor(private state: number) { if (!state) this.state = 1 }
  next(): number {
    let x = this.state
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.state = x >>> 0
    return this.state
  }
  int(maxInclusive: number): number { return this.next() % (maxInclusive + 1) }
  shuffle<T>(values: T[]): T[] {
    for (let i = values.length - 1; i > 0; i--) {
      const j = this.int(i); [values[i], values[j]] = [values[j]!, values[i]!]
    }
    return values
  }
}

const rngFor = (caseNo: number, round = 0) =>
  new XorShift32((defaultSeed ^ Math.imul(caseNo + 1, 0x9e3779b9) ^ round) >>> 0)
const seedMessage = () => `ORCH_HARNESS_SEED=${defaultSeed}\n${mergedTimeline()}`

type Event = { at: string; event: string; actor: string; lock?: string; pid?: number | null }
function events(actor: string): Event[] {
  const path = join(timelines, `${actor}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Event)
}
function mergedTimeline(): string {
  return readdirSync(timelines).flatMap((name) => events(name.replace(/\.jsonl$/, '')))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((event) => `${event.at} ${event.actor} ${event.event}${event.lock ? ` ${event.lock}` : ''}`)
    .join('\n')
}
async function result(child: { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }) {
  const [code, out, err] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { code, out, err }
}
function invoke(args: string[], cwd = repo, extra: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, cli, ...args], {
    cwd, env: gitEnv({ ORCH_DB: storePath,
      ORCH_RUNS: runsPath, ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'lifecycle-harness', ...extra }),
    stdout: 'pipe', stderr: 'pipe',
  })
}
function addBranch(name: string): string {
  const tree = join(fixture, 'trees', name)
  mkdirSync(dirname(tree), { recursive: true })
  git(repo, 'worktree', 'add', '-b', name, tree, 'main')
  writeFileSync(join(tree, `${name}.txt`), `${name}\n`)
  git(tree, 'add', `${name}.txt`)
  git(tree, 'commit', '-m', `DEV-321 ${name}`)
  return tree
}
function configure(gate: string): void {
  configureSettings({ trunk: 'main', keyPrefixes: ['DEV-'], gate })
}
function configureSettings(settings: Record<string, unknown>): void {
  store((database) => database.query(
    `INSERT INTO project (name,path,stack,canon,settings) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET path=excluded.path,settings=excluded.settings`,
  ).run('lifecycle-fixture', repo, null, 0,
    JSON.stringify(settings)))
}
beforeEach(() => {
  store((database) => database.exec('DELETE FROM run_message; DELETE FROM question; DELETE FROM score; DELETE FROM run_mutation_audit; DELETE FROM run; DELETE FROM project;'))
  for (const name of readdirSync(timelines)) rmSync(join(timelines, name), { force: true })
  for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const path = line.slice('worktree '.length)
    if (path !== repo) git(repo, 'worktree', 'remove', '--force', path)
  }
  git(repo, 'reset', '--hard', fixtureBase)
  for (const branch of git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)) {
    if (branch !== 'main') git(repo, 'branch', '-D', branch)
  }
  configure('true')
})

test('Every write transaction is IMMEDIATE; a deferred transaction that later writes is a lock-upgrade race under concurrent dispatch', async () => {
  for (let round = 0; round < rounds; round++) {
    const rng = rngFor(1, round)
    const scratch = join(fixture, `immediate-${round}.db`)
    const scratchRuns = join(fixture, `immediate-runs-${round}`)
    rmSync(scratch, { force: true })
    rmSync(scratchRuns, { recursive: true, force: true })
    const env = { ORCH_DB: scratch, ORCH_RUNS: scratchRuns, ORCH_EXEC_PATH: '/usr/bin/true' }
    const { bootstrapFixtureStore } = await import('../../src/db.ts')
    bootstrapFixtureStore(scratch)
    const n = 3 + rng.int(5)
    const seed = new Database(scratch)
    const asking = seed.query(`INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id) VALUES (datetime('now'),'codex','file-question','q',1,'q','asking','lifecycle-harness') RETURNING id`).get() as { id: number }
    seed.query(`INSERT INTO question (run_id,question,why,asked_at) VALUES (?,'choose','harness',datetime('now'))`).run(asking.id)
    seed.close()
    const dispatches = rng.shuffle(Array.from({ length: n }, (_, i) => i)).map(async (i) => {
      await Bun.sleep(rng.int(150))
      return result(invoke(['do', 'file-question', `concurrent ${i}`, '--agent', 'codex', '--detach'], repo, env))
    })
    const updater = (async () => {
      await Bun.sleep(rng.int(150))
      return result(Bun.spawn([process.execPath, '-e',
        `import{Database}from'bun:sqlite';const d=new Database(process.argv[1]);d.exec('PRAGMA busy_timeout=5000');d.transaction(()=>d.query("UPDATE question SET answer='yes',answered_at=datetime('now') WHERE run_id=?").run(Number(process.argv[2]))).immediate();d.close()`,
        scratch, String(asking.id)], { stdout: 'pipe', stderr: 'pipe' }))
    })()
    const all = await Promise.all([...dispatches, updater])
    expect(all.every((entry) => entry.code === 0), `${seedMessage()}\n${all.map(x => x.err).join('\n')}`).toBe(true)
    expect(all.map((entry) => entry.out + entry.err).join('\n')).not.toContain('database is locked')
    const checked = new Database(scratch)
    expect(checked.query("SELECT COUNT(*) n FROM run WHERE agent='(pending)'").get()).toEqual({ n })
    expect(checked.query('SELECT answer FROM question WHERE run_id=?').get(asking.id)).toEqual({ answer: 'yes' })
    checked.close()
  }
})

function namesRecordedRunTreeInChild(opts: {
  cwd: string; explicitCwd?: boolean; base?: string
  resume?: { parent: number; worktree: { path: string } | null }
}): boolean {
  const r = Bun.spawnSync([process.execPath, '-e',
    `const{registerStandardHooks}=await import(new URL('./store-hooks.ts',process.argv[1]));registerStandardHooks();const{namesRecordedRunTree}=await import(process.argv[1]);console.log(JSON.stringify(namesRecordedRunTree(JSON.parse(process.argv[2]))))`,
    dispatchPreflightModule, JSON.stringify(opts)], {
    cwd: repo, env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString()) as boolean
}

test('A resume is always possible on a stale checkout: a stale new dispatch from the main checkout refuses', async () => {
  store((database) => database.query(`INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,cwd,repo) VALUES (datetime('now'),'codex','file-question','p',1,'p','ok','lifecycle-harness',?, 'lifecycle-fixture')`).run(repo))
  const tree = addBranch('stale-new')
  writeFileSync(join(repo, 'advance-stale.txt'), 'advance\n')
  git(repo, 'add', 'advance-stale.txt')
  git(repo, 'commit', '-m', 'DEV-321 advance after recorded cwd')
  git(repo, 'reset', '--hard', fixtureBase)
  expect(namesRecordedRunTreeInChild({ cwd: repo })).toBe(false)
  expect(namesRecordedRunTreeInChild({ cwd: repo, explicitCwd: true })).toBe(false)
  expect(namesRecordedRunTreeInChild({ cwd: repo, base: 'stale-new' })).toBe(false)
  const r = Bun.spawnSync([process.execPath, '-e',
    `const{assertCallerAncestry}=await import(process.argv[1]);assertCallerAncestry(process.argv[2],JSON.parse(process.argv[3]))`,
    worktreeModule, repo, JSON.stringify({ path: tree, branch: 'stale-new', base: git(tree, 'rev-parse', 'HEAD'), repoRoot: repo })],
    { env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toMatch(invariantLine)
}, 15_000)

test('A resume is always possible on a stale checkout: recorded worktree skips caller ancestry', async () => {
  const tree = addBranch('resume-stale')
  const base = git(tree, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'advance.txt'), 'advance\n'); git(repo, 'add', 'advance.txt'); git(repo, 'commit', '-m', 'DEV-321 advance trunk')
  const inserted = store((database) => database.query(`INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,vendor_session,cwd,worktree,branch,base_commit,repo,turn) VALUES (datetime('now'),'codex','file-question','r',1,'r','ok','lifecycle-harness','vendor-session',?,?,?,?, 'lifecycle-fixture',1) RETURNING id`).get(tree, tree, 'resume-stale', base) as { id: number })
  expect(namesRecordedRunTreeInChild({
    cwd: tree, resume: { parent: inserted.id, worktree: { path: tree } },
  })).toBe(true)
  expect(namesRecordedRunTreeInChild({ cwd: tree, explicitCwd: true })).toBe(true)
  expect(namesRecordedRunTreeInChild({ cwd: repo, base: 'resume-stale' })).toBe(true)
  expect(namesRecordedRunTreeInChild({ cwd: repo, base: 'origin/resume-stale' })).toBe(false)
  const resumed = await result(invoke(['continue', String(inserted.id), 'continue', '--detach'], repo,
    { ORCH_EXEC_PATH: '/usr/bin/true' }))
  expect(resumed.code, `${seedMessage()}\n${resumed.err}`).toBe(0)
}, 15_000)

test(caseName.migration, async () => {
  const copy = join(fixture, 'linked-source')
  const linked = join(fixture, 'linked-tree')
  rmSync(copy, { recursive: true, force: true })
  rmSync(linked, { recursive: true, force: true })
  cpSync(join(sourceRoot, 'orchestrator', 'src'), join(copy, 'orchestrator', 'src'), { recursive: true })
  cpSync(join(sourceRoot, 'orchestrator', 'migrations'), join(copy, 'orchestrator', 'migrations'), { recursive: true })
  cpSync(join(sourceRoot, 'shared'), join(copy, 'shared'), { recursive: true })
  symlinkSync(join(sourceRoot, 'node_modules'), join(copy, 'node_modules'))
  symlinkSync(join(sourceRoot, 'orchestrator', 'node_modules'), join(copy, 'orchestrator', 'node_modules'))
  git(copy, 'init', '-b', 'main'); git(copy, 'config', 'user.email', 'linked@example.invalid'); git(copy, 'config', 'user.name', 'Linked')
  git(copy, 'add', '.'); git(copy, 'commit', '-m', 'DEV-321 linked fixture'); git(copy, 'worktree', 'add', '-b', 'DEV-321-linked', linked)
  const scratch = join(fixture, 'linked-migration.db')
  rmSync(scratch, { force: true })
  const empty = new Database(scratch); empty.close()
  const read = Bun.spawnSync([process.execPath, join(linked, 'orchestrator/src/orch.ts'), 'runs'], { cwd: linked, env: gitEnv({ ORCH_DB: scratch, ORCH_DEPTH: '0' }), stdout: 'pipe', stderr: 'pipe' })
  const checked = new Database(scratch, { readonly: true })
  const columns = checked.query('PRAGMA table_info(run)').all() as { name: string }[]; checked.close()
  violation(caseName.migration, seedMessage(), () => {
    expect(columns.some((column) => column.name === 'label')).toBe(false)
    expect(read.exitCode).not.toBe(0)
    expect(read.stderr.toString()).toMatch(invariantLine)
    expect(read.stderr.toString()).toMatch(/cleared by: orch migrate/)
    expect(read.stderr.toString()).not.toContain('no such column: r.label')
  })
  const migrated = Bun.spawnSync([process.execPath, join(copy, 'orchestrator/src/cli.ts'), 'migrate'], {
    cwd: copy, env: gitEnv({ ORCH_DB: scratch, ORCH_DEPTH: '0' }), stdout: 'pipe', stderr: 'pipe',
  })
  expect(migrated.exitCode, migrated.stderr.toString()).toBe(0)
  expect(migrated.stdout.toString()).toContain('applied 0000_bright_sleepwalker')
  const restored = new Database(scratch, { readonly: true })
  const restoredCols = restored.query('PRAGMA table_info(run)').all() as { name: string }[]
  restored.close()
  expect(restoredCols.some((column) => column.name === 'label')).toBe(true)
})

test(caseName.linkedRefusal, async () => {
  const { LINKED_WORKTREE_WRITE_REFUSAL } = await import('../../src/db.ts')
  expect(LINKED_WORKTREE_WRITE_REFUSAL.length).toBeGreaterThan(0)
  violation(caseName.linkedRefusal, seedMessage(), () => {
    expect(LINKED_WORKTREE_WRITE_REFUSAL).toMatch(invariantLine)
    expect(LINKED_WORKTREE_WRITE_REFUSAL).toMatch(clearingLine)
  })
}, 15_000)
