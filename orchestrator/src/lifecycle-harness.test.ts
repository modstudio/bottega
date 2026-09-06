/**
 * Seeded lifecycle concurrency harness (DEV-321).
 *
 * Refusal contract for chunk 3 (each clause is a complete line):
 *   invariant: <the invariant's bolded phrase from orchestrator/AGENTS.md>
 *   cleared by: <a literal orch or git invocation>
 *
 * Every expected failure records evidence only when its invariant expectation
 * fails. Chunk 3 removes a repaired case from failingCaseNames, changes it to
 * plain test(), and leaves violation() around its now-passing assertion; that
 * produces no record, so the final evidence test remains an exact inventory.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
const storePath = join(fixture, 'orch.db')
const runsPath = join(fixture, 'runs')
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

process.env.ORCH_DB = storePath
process.env.ORCH_RUNS = runsPath
process.env.HOME = home
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
process.env.ORCH_DEPTH = '0'
process.env.CLAUDE_CODE_SESSION_ID = 'lifecycle-harness'

const sourceRoot = join(dirname(new URL(import.meta.url).pathname), '../..')
const cli = join(sourceRoot, 'orchestrator', 'src', 'cli.ts')
const landingModule = new URL('./landing.ts', import.meta.url).href
const worktreeModule = new URL('./worktree.ts', import.meta.url).href

if (!storePath.startsWith(`${fixture}/`)) {
  throw new Error(`lifecycle harness ORCH_DB escaped its fixture: ${storePath}`)
}

const gitEnv = (extra: Record<string, string> = {}) => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name === 'GIT_DIR' || name === 'GIT_WORK_TREE' || name === 'GIT_INDEX_FILE' ||
        name === 'GIT_OBJECT_DIRECTORY' || name === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
        name === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name) ||
        name === 'GIT_CONFIG_GLOBAL' || name === 'GIT_CONFIG_SYSTEM' ||
        name === 'GIT_CONFIG_NOSYSTEM' || name === 'ORCH_GUARDED_GIT_COMMON_DIR' ||
        name === 'ORCH_ALLOWED_GIT_REF') delete env[name]
  }
  return { ...env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', ...extra }
}

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
if (firstEvaluation) {
  const { bootstrapFixtureStore } = await import('./db.ts')
  bootstrapFixtureStore(storePath)
}

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
})

const defaultSeed = Number(process.env.ORCH_HARNESS_SEED ?? '1') >>> 0
const rounds = Math.max(1, Number(process.env.ORCH_HARNESS_ROUNDS ?? '3'))
const invariantLine = /^invariant: .+$/m
const clearingLine = /^cleared by: (?:orch|git) .+$/m

const refusalSiteNames = [
  'caller ancestry', 'missing trunk setting', 'missing gate setting',
  'branch does not exist', 'configured trunk does not exist',
  'branch has no worktree', 'branch is already merged', 'rebase leaves no commits',
  'uncommitted tracked changes', 'rebase in progress',
] as const
const refusalCaseName = (site: string) =>
  `Every refusal names the invariant it protects and the command that clears it: ${site}`
const failingCaseNames = [] as const

const caseName = {
  lockPurpose: 'One lock per purpose',
  fifo: 'A lock waiter is served in arrival order',
  resume: 'A resume is always possible on a stale checkout: attachment never waits on the landing lock',
  migration: 'Only the main checkout binary migrates the store',
  landingGate: 'Landing holds its lock only for re-check, guard verification and fast-forward, never a gate',
  failedLanding: 'A failed landing leaves the branch worktree as it found it',
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
function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}\n${seedMessage()}`))
      await Bun.sleep(5)
    }
    resolve()
  })
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
function snapshotTree(tree: string) {
  const index = git(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
  const listed = git(tree, 'ls-files', '-c', '-o', '--exclude-standard').split('\n').filter(Boolean)
  const files: Record<string, string> = {}
  for (const name of listed) {
    const path = join(tree, name)
    if (existsSync(path)) files[name] = readFileSync(path, 'utf8')
  }
  return {
    head: git(tree, 'rev-parse', 'HEAD'),
    index: existsSync(index) ? readFileSync(index) : null,
    files,
    porcelain: git(tree, 'status', '--porcelain=v1', '--untracked-files=all'),
  }
}
function childLand(branch: string, extra: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, '-e',
    `const {land}=await import(process.argv[1]);land(process.argv[2],process.argv[3],{unreviewed:'DEV-321 harness',timeoutMs:5000})`,
    landingModule, repo, branch], {
    cwd: repo, env: gitEnv({ ORCH_DB: storePath,
      CLAUDE_CODE_SESSION_ID: branch, ...extra }), stdout: 'pipe', stderr: 'pipe',
  })
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
function waiterExists(what: string): boolean {
  const path = join(git(repo, 'rev-parse', '--git-common-dir'), 'orch-landing.waiters')
  if (!existsSync(path)) return false
  return readdirSync(path).some((name) => {
    try { return JSON.parse(readFileSync(join(path, name), 'utf8')).what === what } catch { return false }
  })
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
    const { bootstrapFixtureStore } = await import('./db.ts')
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
}, 20_000)

test(caseName.lockPurpose, async () => {
  const actorCode = `const{appendFileSync,existsSync,readFileSync,readdirSync}=await import('node:fs');const{join}=await import('node:path');const{withProjectLock,withWorktreeCreateLock,withCleanupLock}=await import(process.argv[1]);const [repo,actor,file]=process.argv.slice(2);const log=(event,lock)=>appendFileSync(file,JSON.stringify({at:new Date().toISOString(),event,actor,...(lock?{lock}:{})})+'\\n');log('lock-wait');const action=()=>{const common=Bun.spawnSync(['git','rev-parse','--path-format=absolute','--git-common-dir'],{cwd:repo,stdout:'pipe'}).stdout.toString().trim();const held=readdirSync(common).filter(name=>name.endsWith('.lock')&&existsSync(join(common,name,'owner'))).filter(name=>{try{return JSON.parse(readFileSync(join(common,name,'owner'),'utf8')).pid===process.pid}catch{return false}});const lock=held.length===1?held[0]:'unknown';log('lock-held',lock);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80)};if(actor==='worker')withWorktreeCreateLock(repo,action,2000);else if(actor==='cleanup')withCleanupLock(repo,{session:actor,what:actor},action,2000);else withProjectLock(repo,'landing',{session:actor,what:actor},action,2000,true);log('lock-released');log('exit')`
  const rng = rngFor(2)
  const names = rng.shuffle(['worker', 'lander', 'cleanup'])
  const children = names.map(async (actor) => {
    await Bun.sleep(rng.int(150))
    return result(Bun.spawn([process.execPath, '-e', actorCode,
      worktreeModule, repo, actor, join(timelines, `${actor}.jsonl`)], {
      env: gitEnv({ ORCH_DB: storePath }),
      stdout: 'pipe', stderr: 'pipe',
    }))
  })
  const actorResults = await Promise.all(children)
  expect(actorResults.every((actor) => actor.code === 0),
    actorResults.map((actor) => actor.err).join('\n')).toBe(true)
  const intervals = names.map((actor) => ({ actor, rows: events(actor) }))
  const shared = intervals.flatMap(({ actor, rows }) => rows
    .filter((row) => row.event === 'lock-held').map((row) => ({ actor, lock: row.lock })))
  expect(shared).toHaveLength(3)
  expect(shared.every((row) => row.lock !== undefined && row.lock !== 'unknown'),
    `lock observation itself failed\n${seedMessage()}`).toBe(true)
  violation(caseName.lockPurpose, seedMessage(), () => {
    expect(new Set(shared.map((row) => row.lock)).size, seedMessage()).toBe(3)
  })
}, 15_000)

test(caseName.fifo, async () => {
  for (let round = 0; round < rounds; round++) {
    const rng = rngFor(3, round)
    const release = join(fixture, `fifo-release-${round}`)
    const ready = join(fixture, `fifo-ready-${round}`)
    rmSync(release, { force: true }); rmSync(ready, { force: true })
    const code = `const{appendFileSync,existsSync,writeFileSync}=await import('node:fs');const{withProjectLock}=await import(process.argv[1]);const [repo,actor,file,ready,release,kind]=process.argv.slice(2);const log=e=>appendFileSync(file,JSON.stringify({at:new Date().toISOString(),event:e,actor,lock:'orch-landing.lock'})+'\\n');log('lock-wait');withProjectLock(repo,'landing',{session:actor,what:actor},()=>{log('lock-held');if(kind==='long'){writeFileSync(ready,'');while(!existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}},5000,true);log('lock-released')`
    const spawn = (actor: string, kind = 'short') => Bun.spawn([process.execPath, '-e', code,
      worktreeModule, repo, actor, join(timelines, `${round}-${actor}.jsonl`), ready, release, kind],
    { env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe' })
    const holder = spawn('H', 'long'); await waitFor(ready)
    const a = spawn('A')
    for (let i = 0; i < 200 && !waiterExists('A'); i++) await Bun.sleep(5)
    a.kill('SIGSTOP')
    writeFileSync(release, '')
    const shorts = Array.from({ length: 3 + rng.int(4) }, (_, i) => spawn(`S${i}`))
    for (let i = 0; i < 200; i++) {
      const shortHeld = readdirSync(timelines).filter((name) => name.startsWith(`${round}-S`))
        .some((name) => events(name.replace(/\.jsonl$/, '')).some((event) => event.event === 'lock-held'))
      if (shortHeld) break
      await Bun.sleep(5)
    }
    a.kill('SIGCONT')
    const actorResults = await Promise.all([holder, a, ...shorts].map(result))
    expect(actorResults.every((actor) => actor.code === 0),
      actorResults.map((actor) => actor.err).join('\n')).toBe(true)
    const held = readdirSync(timelines).filter((name) => name.startsWith(`${round}-`))
      .flatMap((name) => events(name.replace(/\.jsonl$/, ''))).filter((e) => e.event === 'lock-held')
      .sort((x, y) => x.at.localeCompare(y.at)).map((e) => e.actor)
    expect(held).toContain('A')
    expect(held.some((actor) => actor.startsWith('S'))).toBe(true)
    violation(caseName.fifo, seedMessage(), () => {
      expect(held.indexOf('A'), seedMessage()).toBeLessThan(
        Math.min(...held.filter(x => x.startsWith('S')).map(x => held.indexOf(x))),
      )
    })
  }
}, 15_000)

test('A resume is always possible on a stale checkout: a stale new dispatch from the main checkout refuses', async () => {
  const { namesRecordedRunTree } = await import('./run.ts')
  store((database) => database.query(`INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,cwd,repo) VALUES (datetime('now'),'codex','file-question','p',1,'p','ok','lifecycle-harness',?, 'lifecycle-fixture')`).run(repo))
  const tree = addBranch('stale-new')
  writeFileSync(join(repo, 'advance-stale.txt'), 'advance\n')
  git(repo, 'add', 'advance-stale.txt')
  git(repo, 'commit', '-m', 'DEV-321 advance after recorded cwd')
  git(repo, 'reset', '--hard', fixtureBase)
  expect(namesRecordedRunTree({ cwd: repo })).toBe(false)
  expect(namesRecordedRunTree({ cwd: repo, explicitCwd: true })).toBe(false)
  expect(namesRecordedRunTree({ cwd: repo, base: 'stale-new' })).toBe(false)
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
  const { namesRecordedRunTree } = await import('./run.ts')
  expect(namesRecordedRunTree({
    cwd: tree, resume: { parent: inserted.id, worktree: { path: tree } },
  })).toBe(true)
  expect(namesRecordedRunTree({ cwd: tree, explicitCwd: true })).toBe(true)
  expect(namesRecordedRunTree({ cwd: repo, base: 'resume-stale' })).toBe(true)
  expect(namesRecordedRunTree({ cwd: repo, base: 'origin/resume-stale' })).toBe(false)
  const resumed = await result(invoke(['continue', String(inserted.id), 'continue', '--detach'], repo,
    { ORCH_EXEC_PATH: '/usr/bin/true' }))
  expect(resumed.code, `${seedMessage()}\n${resumed.err}`).toBe(0)
}, 15_000)

test(caseName.resume, async () => {
  const tree = addBranch('resume-during-gate')
  const base = git(tree, 'rev-parse', 'HEAD')
  const inserted = store((database) => database.query(`INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,vendor_session,cwd,worktree,branch,base_commit,repo,turn) VALUES (datetime('now'),'codex','file-question','r',1,'r','ok','lifecycle-harness','vendor-session',?,?,?,?, 'lifecycle-fixture',1) RETURNING id`).get(tree, tree, 'resume-during-gate', base) as { id: number })
  const ready = join(fixture, 'resume-gate-ready'), release = join(fixture, 'resume-gate-release')
  rmSync(ready, { force: true }); rmSync(release, { force: true })
  const gateFile = join(timelines, 'resume-gate.jsonl')
  const holder = Bun.spawn([process.execPath, '-e', `const{appendFileSync,writeFileSync,existsSync}=await import('node:fs');const{withProjectLock}=await import(process.argv[1]);const[repo,file,ready,release]=process.argv.slice(2);withProjectLock(repo,'landing',{session:'lander',what:'gate'},()=>{appendFileSync(file,JSON.stringify({at:new Date().toISOString(),event:'gate-start',actor:'lander'})+'\\n');writeFileSync(ready,'');while(!existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);appendFileSync(file,JSON.stringify({at:new Date().toISOString(),event:'gate-end',actor:'lander'})+'\\n')},5000,true)`, worktreeModule, repo, gateFile, ready, release], { env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe' })
  await waitFor(ready)
  const agentExit = join(fixture, 'resume-agent-exit')
  rmSync(agentExit, { force: true })
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf '%s' "$ORCH_RUN_ID" > '${agentExit}'\nprintf '{"status":"done","summary":"ok","files_changed":null,"questions":null,"deviations":null,"blockers":null,"tests":null}\\n'\n`)
  chmodSync(join(bin, 'codex'), 0o755)
  const resume = invoke(['continue', String(inserted.id), 'continue', '--detach'], repo)
  const resumed = await result(resume)
  const resumedId = Number(resumed.out.trim())
  expect(resumedId).toBeGreaterThan(0)
  for (let i = 0; i < 80 && !(existsSync(agentExit) && readFileSync(agentExit, 'utf8') === String(resumedId)); i++) {
    await Bun.sleep(25)
  }
  const premature = existsSync(agentExit) && readFileSync(agentExit, 'utf8') === String(resumedId)
  writeFileSync(release, '')
  await result(holder)
  for (let i = 0; i < 400 && (!existsSync(agentExit) || readFileSync(agentExit, 'utf8') !== String(resumedId)); i++) await Bun.sleep(5)
  expect(readFileSync(agentExit, 'utf8')).toBe(String(resumedId))
  for (let i = 0; i < 400; i++) {
    const row = store((database) => database.query('SELECT status FROM run WHERE id=?').get(resumedId) as { status: string } | null)
    if (row?.status !== 'running') break
    await Bun.sleep(5)
  }
  expect(store((database) => (database.query('SELECT status FROM run WHERE id=?').get(resumedId) as { status: string }).status))
    .not.toBe('running')
  violation(caseName.resume, seedMessage(), () => {
    expect(premature, seedMessage()).toBe(true)
  })
}, 15_000)

test(caseName.migration, async () => {
  const copy = join(fixture, 'linked-source')
  const linked = join(fixture, 'linked-tree')
  rmSync(copy, { recursive: true, force: true })
  rmSync(linked, { recursive: true, force: true })
  cpSync(join(sourceRoot, 'orchestrator', 'src'), join(copy, 'orchestrator', 'src'), { recursive: true })
  cpSync(join(sourceRoot, 'shared'), join(copy, 'shared'), { recursive: true })
  symlinkSync(join(sourceRoot, 'orchestrator', 'node_modules'), join(copy, 'orchestrator', 'node_modules'))
  git(copy, 'init', '-b', 'main'); git(copy, 'config', 'user.email', 'linked@example.invalid'); git(copy, 'config', 'user.name', 'Linked')
  git(copy, 'add', '.'); git(copy, 'commit', '-m', 'DEV-321 linked fixture'); git(copy, 'worktree', 'add', '-b', 'DEV-321-linked', linked)
  const scratch = join(fixture, 'linked-migration.db')
  rmSync(scratch, { force: true })
  const init = Bun.spawnSync([process.execPath, join(copy, 'orchestrator/src/cli.ts'), 'init-db'], { cwd: copy, env: gitEnv({ ORCH_DB: scratch, ORCH_DEPTH: '0' }), stdout: 'pipe', stderr: 'pipe' })
  expect(init.exitCode, init.stderr.toString()).toBe(0)
  const before = new Database(scratch); before.exec('ALTER TABLE run DROP COLUMN label'); before.close()
  const read = Bun.spawnSync([process.execPath, join(linked, 'orchestrator/src/cli.ts'), 'runs'], { cwd: linked, env: gitEnv({ ORCH_DB: scratch, ORCH_DEPTH: '0' }), stdout: 'pipe', stderr: 'pipe' })
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
  expect(migrated.stdout.toString()).toContain('run.label')
  const restored = new Database(scratch, { readonly: true })
  const restoredCols = restored.query('PRAGMA table_info(run)').all() as { name: string }[]
  restored.close()
  expect(restoredCols.some((column) => column.name === 'label')).toBe(true)
}, 20_000)

test(caseName.landingGate, async () => {
  const branches = ['gate-one', 'gate-two']; branches.forEach(addBranch)
  const release = branches.map((branch) => join(fixture, `${branch}-release`))
  release.forEach((path) => rmSync(path, { force: true }))
  const gate = join(fixture, 'barrier-gate.ts')
  writeFileSync(gate, `#!/usr/bin/env bun\nimport{appendFileSync,existsSync}from'node:fs';import{resolve,join}from'node:path';const actor=Bun.spawnSync(['git','branch','--show-current'],{stdout:'pipe'}).stdout.toString().trim();const common=Bun.spawnSync(['git','rev-parse','--git-common-dir'],{stdout:'pipe'}).stdout.toString().trim();const lock=resolve(process.cwd(),common,'orch-landing.lock');appendFileSync('${join(timelines, 'gates.jsonl')}',JSON.stringify({at:new Date().toISOString(),event:'gate-start',actor,lock,pid:existsSync(join(lock,'owner'))?JSON.parse(await Bun.file(join(lock,'owner')).text()).pid:null})+'\\n');const release='${fixture}/'+actor+'-release';while(!existsSync(release))await Bun.sleep(5);appendFileSync('${join(timelines, 'gates.jsonl')}',JSON.stringify({at:new Date().toISOString(),event:'gate-end',actor,lock})+'\\n')\n`)
  chmodSync(gate, 0o755); configure(gate)
  const landers = branches.map((branch) => childLand(branch))
  const landingResults = landers.map(result)
  for (const branch of branches) while (!events('gates').some(e => e.actor === branch)) await Bun.sleep(5)
  const order = rngFor(6).shuffle([0, 1]); writeFileSync(release[order[0]!]!, ''); await landingResults[order[0]!]!; writeFileSync(release[order[1]!]!, '')
  const landed = await Promise.all(landingResults); expect(landed.every(x => x.code === 0), landed.map(x => x.err).join('\n')).toBe(true)
  const gateStarts = events('gates').filter(e => e.event === 'gate-start')
  expect(gateStarts.length).toBeGreaterThanOrEqual(2)
  violation(caseName.landingGate, seedMessage(), () => {
    expect(gateStarts.every(e => e.pid === null), seedMessage()).toBe(true)
  })
}, 20_000)

test(caseName.failedLanding, async () => {
  const tree = addBranch('failed-landing')
  writeFileSync(join(repo, 'trunk-only.txt'), 'trunk\n'); git(repo, 'add', 'trunk-only.txt'); git(repo, 'commit', '-m', 'DEV-321 move trunk')
  configure('false')
  const before = { head: git(tree, 'rev-parse', 'HEAD'), status: git(tree, 'status', '--porcelain'), rebase: existsSync(join(tree, '.git/rebase-merge')) || existsSync(join(tree, '.git/rebase-apply')) }
  const landed = await result(childLand('failed-landing'))
  const after = { head: git(tree, 'rev-parse', 'HEAD'), status: git(tree, 'status', '--porcelain'), rebase: existsSync(join(tree, '.git/rebase-merge')) || existsSync(join(tree, '.git/rebase-apply')) }
  expect(landed.code).not.toBe(0)
  violation(caseName.failedLanding, seedMessage(), () => {
    expect(after, seedMessage()).toEqual(before)
  })
}, 15_000)

test('A reclaim removes exactly the acquisition it classified as stale', async () => {
  const { withProjectLock } = await import('./worktree.ts')
  const deadPid = 2_147_483_647
  const lock = join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'orch-landing.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner'), `${JSON.stringify({
    pid: deadPid, startTime: null, incarnation: 'classified-a',
    session: 'dead', what: 'stale-holder', since: new Date(0).toISOString(),
  })}\n`)
  const ready = join(fixture, 'reclaim-ready')
  const release = join(fixture, 'reclaim-release')
  const done = join(fixture, 'reclaim-done')
  rmSync(ready, { force: true }); rmSync(release, { force: true }); rmSync(done, { force: true })
  const child = Bun.spawn([process.execPath, '-e',
    `const{writeFileSync}=await import('node:fs');const{reclaimStaleProjectLock}=await import(process.argv[1]);const result=reclaimStaleProjectLock(process.argv[2],'landing');writeFileSync(process.argv[3],JSON.stringify(result))`,
    worktreeModule, repo, done], {
    env: gitEnv({
      ORCH_DB: storePath,
      ORCH_TEST_LOCK_RECLAIM_CHECKPOINT: 'classified',
      ORCH_TEST_LOCK_RECLAIM_READY: ready,
      ORCH_TEST_LOCK_RECLAIM_RELEASE: release,
    }),
    stdout: 'pipe', stderr: 'pipe',
  })
  await waitFor(ready)
  rmSync(lock, { recursive: true, force: true })
  const liveIncarnation = withProjectLock(repo, 'landing', { session: 'live', what: 'replacement' }, () => {
    const live = JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')) as { incarnation: string }
    writeFileSync(release, '')
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 5000
    while (!existsSync(done)) {
      if (Date.now() >= deadline) throw new Error(`reclaim child did not finish\n${seedMessage()}`)
      Atomics.wait(sleeper, 0, 0, 10)
    }
    expect(JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')).incarnation).toBe(live.incarnation)
    return live.incarnation
  }, 8000, true)
  expect(liveIncarnation).toBeDefined()
  expect(JSON.parse(readFileSync(done, 'utf8'))).toBeNull()
  const reclaimed = await result(child)
  expect(reclaimed.code, reclaimed.err).toBe(0)
  expect(existsSync(lock)).toBe(false)
}, 15_000)

class RefusalSetupError extends Error {}
const refusedLand = (branch: string) => {
  const r = Bun.spawnSync([process.execPath, '-e',
    `const{land}=await import(process.argv[1]);land(process.argv[2],process.argv[3],{unreviewed:'test'})`,
    landingModule, repo, branch], {
    env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe',
  })
  if (r.exitCode === 0) throw new RefusalSetupError('landing unexpectedly succeeded')
  return r.stderr.toString()
}
const refusalCases = [
  ['caller ancestry', () => {
    const tree = addBranch('ancestry-refusal'); const base = git(tree, 'rev-parse', 'HEAD')
    git(repo, 'reset', '--hard', `${fixtureBase}`)
    const r = Bun.spawnSync([process.execPath, '-e', `const{assertCallerAncestry}=await import(process.argv[1]);assertCallerAncestry(process.argv[2],JSON.parse(process.argv[3]))`, worktreeModule, repo, JSON.stringify({ path: tree, branch: 'ancestry-refusal', base, repoRoot: repo })], { env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode === 0) throw new RefusalSetupError('caller ancestry unexpectedly succeeded')
    return r.stderr.toString()
  }],
  ['missing trunk setting', () => { configureSettings({ gate: 'true' }); addBranch('no-trunk-setting'); return refusedLand('no-trunk-setting') }],
  ['missing gate setting', () => { configureSettings({ trunk: 'main' }); addBranch('no-gate-setting'); return refusedLand('no-gate-setting') }],
  ['branch does not exist', () => refusedLand('absent-branch')],
  ['configured trunk does not exist', () => { addBranch('missing-trunk-ref'); configureSettings({ trunk: 'absent-trunk', gate: 'true' }); return refusedLand('missing-trunk-ref') }],
  ['branch has no worktree', () => { git(repo, 'branch', 'no-worktree'); return refusedLand('no-worktree') }],
  ['branch is already merged', () => { const tree = join(fixture, 'trees', 'already-merged'); mkdirSync(dirname(tree), { recursive: true }); git(repo, 'worktree', 'add', '-b', 'already-merged', tree, 'main'); return refusedLand('already-merged') }],
  ['rebase leaves no commits', () => {
    const tree = join(fixture, 'trees', 'empty-after-rebase')
    mkdirSync(dirname(tree), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'empty-after-rebase', tree, 'main')
    writeFileSync(join(tree, 'same.txt'), 'same\n'); git(tree, 'add', 'same.txt'); git(tree, 'commit', '-m', 'DEV-321 branch copy')
    writeFileSync(join(repo, 'same.txt'), 'same\n'); git(repo, 'add', 'same.txt'); git(repo, 'commit', '-m', 'DEV-321 trunk copy')
    return refusedLand('empty-after-rebase')
  }],
  ['uncommitted tracked changes', () => {
    const tree = addBranch('dirty-tracked')
    writeFileSync(join(tree, 'dirty-tracked.txt'), 'edited\n')
    return refusedLand('dirty-tracked')
  }],
  ['rebase in progress', () => {
    const tree = addBranch('rebase-in-progress')
    const gitDir = git(tree, 'rev-parse', '--path-format=absolute', '--git-dir')
    mkdirSync(join(gitDir, 'rebase-merge'))
    return refusedLand('rebase-in-progress')
  }],
] as const

for (const [index, [site, trigger]] of refusalCases.entries()) {
  const name = refusalCaseName(site)
  test(name, () => {
    expect(site).toBe(refusalSiteNames[index])
    const message = trigger()
    expect(message.length).toBeGreaterThan(0)
    violation(name, seedMessage(), () => {
      expect(message).toMatch(invariantLine)
      expect(message).toMatch(clearingLine)
    })
  }, 15_000)
}

test(caseName.linkedRefusal, async () => {
  const { LINKED_WORKTREE_WRITE_REFUSAL } = await import('./db.ts')
  expect(LINKED_WORKTREE_WRITE_REFUSAL.length).toBeGreaterThan(0)
  violation(caseName.linkedRefusal, seedMessage(), () => {
    expect(LINKED_WORKTREE_WRITE_REFUSAL).toMatch(invariantLine)
    expect(LINKED_WORKTREE_WRITE_REFUSAL).toMatch(clearingLine)
  })
}, 15_000)

test('The guard on disk is verified against HEAD before fast-forward', async () => {
  mkdirSync(join(repo, 'orchestrator', 'hooks'), { recursive: true })
  const hook = join(sourceRoot, 'orchestrator', 'hooks', 'reference-transaction')
  const staged = join(repo, 'orchestrator', 'hooks', 'reference-transaction')
  writeFileSync(staged, readFileSync(hook))
  git(repo, 'add', 'orchestrator/hooks/reference-transaction')
  git(repo, 'commit', '-m', 'DEV-321 tracked guard')
  addBranch('guard-land')
  writeFileSync(staged, '#!/bin/sh\nexit 0\n')
  git(repo, 'add', 'orchestrator/hooks/reference-transaction')
  const order = join(fixture, 'landing-order.log')
  rmSync(order, { force: true })
  const trunkBefore = git(repo, 'rev-parse', 'HEAD')
  const landed = await result(childLand('guard-land', { ORCH_TEST_LANDING_ORDER: order }))
  expect(landed.code, landed.err).toBe(0)
  expect(readFileSync(staged)).toEqual(readFileSync(hook))
  expect(git(repo, 'status', '--porcelain', '--', 'orchestrator/hooks/reference-transaction')).toBe('')
  expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(trunkBefore)
  expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['guard-verify', 'fast-forward'])
}, 15_000)

test('Landing versus cleanup of one tree take a per-artifact lease', async () => {
  const tree = addBranch('lease-tree')
  const ready = join(fixture, 'lease-land-ready')
  const release = join(fixture, 'lease-land-release')
  rmSync(ready, { force: true }); rmSync(release, { force: true })
  const gate = join(fixture, 'lease-gate.ts')
  writeFileSync(gate, `#!/usr/bin/env bun\nimport{writeFileSync,existsSync}from'node:fs'\nwriteFileSync('${ready}','')\nwhile(!existsSync('${release}'))await Bun.sleep(5)\n`)
  chmodSync(gate, 0o755); configure(gate)
  const lander = childLand('lease-tree')
  await waitFor(ready)
  const cleanupLog = join(timelines, 'lease-cleanup.jsonl')
  const cleanup = Bun.spawn([process.execPath, '-e',
    `const{appendFileSync}=await import('node:fs');const{withWorktreeLease,withCleanupLock}=await import(process.argv[1]);const[repo,tree,file]=process.argv.slice(2);const log=e=>appendFileSync(file,JSON.stringify({at:new Date().toISOString(),event:e,actor:'cleanup'})+'\\n');log('lock-wait');withWorktreeLease(repo,tree,{session:'cleanup',what:'cleanup'},()=>{withCleanupLock(repo,{session:'cleanup',what:'cleanup'},()=>{log('lock-held')},5000);log('lock-released')},5000)`,
    worktreeModule, repo, tree, cleanupLog], {
    env: gitEnv({ ORCH_DB: storePath }), stdout: 'pipe', stderr: 'pipe',
  })
  const waitedUntil = Date.now() + 5000
  while (!events('lease-cleanup').some((e) => e.event === 'lock-wait')) {
    if (Date.now() >= waitedUntil) throw new Error(`cleanup never waited on the tree lease\n${seedMessage()}`)
    await Bun.sleep(5)
  }
  const heldDuringGate = events('lease-cleanup').some((e) => e.event === 'lock-held')
  writeFileSync(release, '')
  const landed = await result(lander)
  const cleaned = await result(cleanup)
  expect(landed.code, landed.err).toBe(0)
  expect(cleaned.code, cleaned.err).toBe(0)
  expect(heldDuringGate, seedMessage()).toBe(false)
  expect(events('lease-cleanup').some((e) => e.event === 'lock-held')).toBe(true)
}, 20_000)

test('A failed landing leaves uncommitted tracked and untracked carry byte-identical', async () => {
  const cases: { name: string; setup: (tree: string) => void; refuseBeforeRebase: boolean }[] = [
    { name: 'unstaged', setup: (tree) => { writeFileSync(join(tree, 'unstaged.txt'), 'unstaged-bytes\n'); git(tree, 'add', 'unstaged.txt'); git(tree, 'commit', '-m', 'DEV-321 track'); writeFileSync(join(tree, 'unstaged.txt'), 'unstaged-edited\n') }, refuseBeforeRebase: true },
    { name: 'staged', setup: (tree) => { writeFileSync(join(tree, 'staged.txt'), 'staged-bytes\n'); git(tree, 'add', 'staged.txt') }, refuseBeforeRebase: true },
    { name: 'mixed', setup: (tree) => { writeFileSync(join(tree, 'mixed.txt'), 'mixed-base\n'); git(tree, 'add', 'mixed.txt'); git(tree, 'commit', '-m', 'DEV-321 mixed'); writeFileSync(join(tree, 'mixed.txt'), 'mixed-staged\n'); git(tree, 'add', 'mixed.txt'); writeFileSync(join(tree, 'mixed.txt'), 'mixed-unstaged\n') }, refuseBeforeRebase: true },
    { name: 'untracked', setup: (tree) => { writeFileSync(join(tree, 'untracked.txt'), 'untracked-bytes\n') }, refuseBeforeRebase: false },
  ]
  for (const item of cases) {
    const tree = addBranch(`carry-${item.name}`)
    item.setup(tree)
    const before = snapshotTree(tree)
    if (!item.refuseBeforeRebase) configure('false')
    const landed = await result(childLand(`carry-${item.name}`))
    const after = snapshotTree(tree)
    expect(landed.code, `${item.name}\n${landed.err}`).not.toBe(0)
    expect(after, item.name).toEqual(before)
    if (item.refuseBeforeRebase) {
      expect(landed.err).toMatch(invariantLine)
      expect(landed.err).toMatch(clearingLine)
    }
    git(repo, 'reset', '--hard', fixtureBase)
    for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length)
      if (path !== repo) git(repo, 'worktree', 'remove', '--force', path)
    }
    for (const branch of git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)) {
      if (branch !== 'main') git(repo, 'branch', '-D', branch)
    }
    configure('true')
  }
}, 30_000)

test('Hermetic git in the gate is an observation; the lifecycle invariant does not cover the gate', async () => {
  addBranch('gate-environment')
  const observed = join(fixture, 'gate-environment.json')
  const gate = join(fixture, 'observe-git-env.sh')
  writeFileSync(gate, `#!/bin/sh\nprintf '{"GIT_DIR":"%s","GIT_OBJECT_DIRECTORY":"%s","GIT_INDEX_FILE":"%s"}\\n' "$GIT_DIR" "$GIT_OBJECT_DIRECTORY" "$GIT_INDEX_FILE" > '${observed}'\n`)
  chmodSync(gate, 0o755); configure(gate)
  const tree = join(fixture, 'trees', 'gate-environment')
  const inherited = {
    GIT_DIR: git(tree, 'rev-parse', '--absolute-git-dir'),
    GIT_OBJECT_DIRECTORY: join(git(tree, 'rev-parse', '--git-common-dir'), 'objects'),
    GIT_INDEX_FILE: git(tree, 'rev-parse', '--git-path', 'index'),
  }
  const landed = await result(childLand('gate-environment', inherited))
  expect(landed.code, landed.err).toBe(0)
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual(inherited)
}, 15_000)

// Serial file order makes this the closing proof that setup failures were never
// mistaken for expected invariant failures above.
test('every failing case failed on its invariant, not on its setup', () => {
  const records = existsSync(violationsFile)
    ? readFileSync(violationsFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { case: string })
    : []
  for (const name of failingCaseNames) {
    expect(records.filter((record) => record.case === name), name).toHaveLength(1)
  }
  expect([...new Set(records.map((record) => record.case))].sort())
    .toEqual([...failingCaseNames].sort())
}, 15_000)
