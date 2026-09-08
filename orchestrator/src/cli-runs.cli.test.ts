import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { DASHBOARD_CAPABILITY_PATH_ENV, DASHBOARD_CAPABILITY_TOKEN_ENV } from '../../shared/dashboard-capability.ts'
import { MIN_SAMPLE, recordDuels, runJson, addRun, db, declaredCreate, dir, fakeDocker, hermeticGitEnv, recordReview, reviewCalibration, reviewReply, score, state, upsertProject } from '../test/fixture.ts'

import { runCollectionDescribeFixture } from '../test/fixture.ts'

/**
 * The derived graph is STATIC relative imports only. That catches the case
 * that actually happens — someone adds a static import of a heavy module into
 * the degraded path, which is precisely how failure.ts arrived and broke this.
 * It does NOT catch a future dynamic import of a heavy module into orch.ts's
 * fallback branch.
 *
 * Bun erases `import type` at runtime (checked: `import type` from a missing
 * file still loads). collect.ts's type-only import of db.ts is therefore not
 * part of this graph and must not be copied.
 *
 * Derive the closure to decide what the shadow copies, so the fixture cannot
 * go stale. Assert it equals this declared set so growth is a reviewed act
 * rather than a silent edit to a copy list.
 */
const DEGRADED_COLLECTION_GRAPH = [
  'collect.ts',
  'failure.ts',
  'orch.ts',
  'outcome.ts',
  'result-output.ts',
] as const

const DEGRADED_HEAVY_MODULES = [
  'agents.ts',
  'cli.ts',
  'landing.ts',
  'route.ts',
  'run.ts',
  'worktree.ts',
] as const

const SRC_DIR = dirname(new URL(import.meta.url).pathname)

function staticRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    const clause = match[1]!.trim()
    if (clause === 'type' || clause.startsWith('type ')) continue
    const spec = match[2]!
    if (spec.startsWith('.')) specifiers.push(spec)
  }
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    const spec = match[1]!
    if (spec.startsWith('.')) specifiers.push(spec)
  }
  for (const match of source.matchAll(/^export\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    const spec = match[1]!
    if (spec.startsWith('.')) specifiers.push(spec)
  }
  return specifiers
}

function staticRelativeImportClosure(entryPath: string): string[] {
  const root = dirname(entryPath)
  const seen = new Set<string>()
  const queue = [resolve(entryPath)]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const spec of staticRelativeSpecifiers(source)) {
      queue.push(resolve(dirname(file), spec))
    }
  }
  return [...seen].map((file) => relative(root, file)).sort()
}

function assertNoHeavyDegradedModules(files: Iterable<string>): void {
  const present = new Set(files)
  for (const name of DEGRADED_HEAVY_MODULES) {
    if (present.has(name)) {
      throw new Error(`degraded collection graph includes heavy module ${name}`)
    }
  }
}

function assertDegradedCollectionGraph(files: Iterable<string>): void {
  assertNoHeavyDegradedModules(files)
  const actual = [...files].sort()
  const expected = [...DEGRADED_COLLECTION_GRAPH].sort()
  if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
    throw new Error(
      `degraded collection graph drifted: got ${actual.join(', ') || '(empty)'}; expected ${expected.join(', ')}`,
    )
  }
}

function writeDegradedShadow(shadow: string): string[] {
  const files = staticRelativeImportClosure(join(SRC_DIR, 'orch.ts'))
  assertDegradedCollectionGraph(files)
  mkdirSync(shadow, { recursive: true })
  for (const rel of files) {
    if (rel === 'cli.ts') continue
    const dest = join(shadow, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(join(SRC_DIR, rel), 'utf8'))
  }
  writeFileSync(join(shadow, 'cli.ts'), '<<<<<<< ours\n')
  return files
}

describe('degraded collection import graph', () => {
  test('derived closure matches the declared set and includes failure.ts without a hand-written copy list', () => {
    const files = staticRelativeImportClosure(join(SRC_DIR, 'orch.ts'))
    expect(files).toContain('failure.ts')
    assertDegradedCollectionGraph(files)
  })

  test('heavy-module assertion fails by name if cli.ts, run.ts or agents.ts enter the graph', () => {
    expect(() => assertNoHeavyDegradedModules(['orch.ts', 'cli.ts']))
      .toThrow(/heavy module cli\.ts/)
    expect(() => assertNoHeavyDegradedModules(['orch.ts', 'run.ts']))
      .toThrow(/heavy module run\.ts/)
    expect(() => assertNoHeavyDegradedModules(['orch.ts', 'agents.ts']))
      .toThrow(/heavy module agents\.ts/)
    expect(() => assertDegradedCollectionGraph([
      ...DEGRADED_COLLECTION_GRAPH, 'run.ts',
    ])).toThrow(/heavy module run\.ts/)
    expect(() => assertNoHeavyDegradedModules([...DEGRADED_COLLECTION_GRAPH])).not.toThrow()
  })

  test('type-only and dynamic relative imports are not followed', () => {
    expect(staticRelativeSpecifiers("import type { ObservedDeadRun } from './db.ts'\n")).toEqual([])
    expect(staticRelativeSpecifiers("import { FAILS_OVER } from './failure.ts'\n")).toEqual(['./failure.ts'])
    expect(staticRelativeSpecifiers("await import('./cli.ts')\n")).toEqual([])
    expect(staticRelativeSpecifiers("const { initializeDatabase } = await import('./db.ts')\n")).toEqual([])
  })
})

describe("detached run collection", () => {
  const { CLI, orchInput, orch, scoreReminder, orchFrom, insert, dispatchArtifacts, expectNoDispatchArtifacts } = runCollectionDescribeFixture()
  const confinementArtifact = () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-confinement-clear-')))
    const git = (cwd: string, ...args: string[]) => {
      const child = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (child.exitCode !== 0) throw new Error(child.stderr.toString())
      return child.stdout.toString().trim()
    }
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', 'base.txt'); git(repo, 'commit', '-m', 'base')
    const branch = 'confinement-work'
    const worktree = join(repo, 'trees', branch)
    mkdirSync(dirname(worktree), { recursive: true })
    git(repo, 'worktree', 'add', '-b', branch, worktree, 'main')
    writeFileSync(join(worktree, 'change.txt'), 'change\n')
    git(worktree, 'add', 'change.txt'); git(worktree, 'commit', '-m', 'change')
    const tip = git(worktree, 'rev-parse', 'HEAD')
    const tree = git(worktree, 'rev-parse', 'HEAD^{tree}')
    const project = `confinement-${randomUUID()}`
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'failed', session: 'orch-test-session',
      repo: project, inputTree: tree, headCommit: tip,
    })
    db().query(
      'UPDATE run SET worktree=?,branch=?,failure_kind=?,error=?,pre_confinement=? WHERE id=?',
    ).run(worktree, branch, 'escaped', 'outside edit', JSON.stringify({
      status: 'ok', failureKind: null, error: null,
    }), id)
    const audit = () => JSON.parse((db().query(
      'SELECT reason FROM run_mutation_audit WHERE run_id=? AND action=\'reclassify\' ORDER BY rowid DESC',
    ).get(id) as { reason: string }).reason) as Record<string, unknown>
    return { repo, worktree, branch, tip, tree, project, id, git, audit }
  }

  test('confinement clear restores an unchanged artifact and audits both tips and trees', () => {
    const fixture = confinementArtifact()
    try {
      const cleared = orch(
        'confinement', 'clear', String(fixture.id), '--writer', 'session-elsewhere',
        '--note', 'known edit',
      )
      expect(cleared.code, cleared.err).toBe(0)
      expect(db().query('SELECT status,failure_kind,error FROM run WHERE id=?').get(fixture.id)).toEqual({
        status: 'ok', failure_kind: null, error: null,
      })
      expect(fixture.audit()).toMatchObject({
        writer: 'session-elsewhere', note: 'known edit', recordedTip: fixture.tip,
        currentTip: fixture.tip, recordedTree: fixture.tree, currentTree: fixture.tree,
        divergence: false, cleared: true,
      })
    } finally { rmSync(fixture.repo, { recursive: true, force: true }) }
  })

  test('confinement clear records a missing worktree block and landing names its recovery', () => {
    const fixture = confinementArtifact()
    try {
      fixture.git(fixture.repo, 'worktree', 'remove', fixture.worktree)
      const cleared = orch(
        'confinement', 'clear', String(fixture.id), '--writer', 'operator', '--note', 'known edit',
      )
      expect(cleared.code, cleared.err).toBe(0)
      expect(cleared.out).toContain(`landing remains blocked: recorded worktree ${fixture.worktree} is missing`)
      expect(cleared.out).toContain(`cleared by: git worktree add ${fixture.worktree} ${fixture.branch}`)
      const pre = JSON.parse((db().query('SELECT pre_confinement FROM run WHERE id=?').get(fixture.id) as
        { pre_confinement: string }).pre_confinement)
      expect(pre.landingBlock).toMatchObject({ worktree: fixture.worktree })
      const landing = orchFrom(fixture.repo, 'orch-test-session',
        'land', String(fixture.id), '--unreviewed', 'fixture')
      expect(landing.code).not.toBe(0)
      expect(landing.err).toContain(`recorded worktree ${fixture.worktree} is missing`)
      expect(landing.err).toContain('invariant:')
      expect(landing.err).toContain(`cleared by: git worktree add ${fixture.worktree} ${fixture.branch}`)
    } finally { rmSync(fixture.repo, { recursive: true, force: true }) }
  })

  test('confinement clear refuses a moved tip without --tip and audits the divergence', () => {
    const fixture = confinementArtifact()
    try {
      writeFileSync(join(fixture.worktree, 'later.txt'), 'later\n')
      fixture.git(fixture.worktree, 'add', 'later.txt')
      fixture.git(fixture.worktree, 'commit', '-m', 'later')
      const currentTip = fixture.git(fixture.worktree, 'rev-parse', 'HEAD')
      const refused = orch(
        'confinement', 'clear', String(fixture.id), '--writer', 'operator', '--note', 'known edit',
      )
      expect(refused.code).not.toBe(0)
      expect(refused.err).toContain(`pass --tip ${currentTip}`)
      expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(fixture.id))
        .toEqual({ failure_kind: 'escaped' })
      expect(fixture.audit()).toMatchObject({
        recordedTip: fixture.tip, currentTip, divergence: true, suppliedTip: null, cleared: false,
      })
    } finally { rmSync(fixture.repo, { recursive: true, force: true }) }
  })

  test('confinement clear accepts an acknowledged moved tip and audits it', () => {
    const fixture = confinementArtifact()
    try {
      writeFileSync(join(fixture.worktree, 'later.txt'), 'later\n')
      fixture.git(fixture.worktree, 'add', 'later.txt')
      fixture.git(fixture.worktree, 'commit', '-m', 'later')
      const currentTip = fixture.git(fixture.worktree, 'rev-parse', 'HEAD')
      const currentTree = fixture.git(fixture.worktree, 'rev-parse', 'HEAD^{tree}')
      const cleared = orch(
        'confinement', 'clear', String(fixture.id), '--writer', 'operator', '--note', 'known edit',
        '--tip', currentTip,
      )
      expect(cleared.code, cleared.err).toBe(0)
      expect(db().query('SELECT status,failure_kind FROM run WHERE id=?').get(fixture.id))
        .toEqual({ status: 'ok', failure_kind: null })
      expect(fixture.audit()).toMatchObject({
        recordedTip: fixture.tip, currentTip, recordedTree: fixture.tree, currentTree,
        divergence: true, suppliedTip: currentTip, cleared: true,
      })
    } finally { rmSync(fixture.repo, { recursive: true, force: true }) }
  })
test('record-only closes the question, marks the chain stranded, and retry restates the ruling', () => {
    const id = insert('asking', 'file-question')
    const prompt = join(dir, `record-only-${id}.prompt.txt`)
    writeFileSync(prompt, 'original fixture spec')
    db().query('UPDATE run SET session_id=?, prompt_path=?, cwd=? WHERE id=?')
      .run('orch-test-session', prompt, dir, id)
    db().query('UPDATE run SET vendor_session=? WHERE id=?').run('valid-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')

    const recorded = orch('answer', String(id), '--record-only', 'use the existing shape')
    expect(recorded.code).toBe(0)
    expect(recorded.out).toContain('resume was skipped by --record-only')
    expect(db().query(
      'SELECT answer, answered_by, answered_at, delivery_pending_at FROM question WHERE run_id=?',
    ).get(id)).toEqual({
      answer: 'use the existing shape', answered_by: 'orch-test-session',
      answered_at: expect.any(String), delivery_pending_at: expect.any(String),
    })

    const inbox = orch('inbox')
    expect(inbox.out).toContain(`asking, but no ruling is open — stranded`)
    expect(inbox.out).toContain(`orch retry ${id} --agent`)
    expect(inbox.out).toContain(`orch abandon ${id}`)
    expect(inbox.out).not.toContain(`recoverable: orch continue ${id}`)
    const runs = orch('runs', '--id', String(id))
    expect(runs.out).toMatch(new RegExp(`\\b${id}\\s+codex\\s+file-question\\s+stranded\\b`))
    expect(runs.out).toContain(`orch retry ${id} --agent`)

    const binDir = mkdtempSync(join(tmpdir(), 'orch-record-only-retry-'))
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const retried = orchInput(['retry', String(id), '--agent', 'grok'], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      })
      expect(retried.code, retried.err).toBe(0)
      const child = db().query('SELECT prompt_path FROM run WHERE retry_of=?').get(id) as
        { prompt_path: string }
      const resent = readFileSync(child.prompt_path, 'utf8')
      expect(resent).toContain('original fixture spec')
      expect(resent).toContain('YOU ASKED: which shape?')
      expect(resent).toContain('THE RULING: use the existing shape')
      expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(id))
        .toEqual({ delivery_pending_at: null })
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('retry through a child delivers a pending ruling from a non-asking stranded root', () => {
    const root = insert('failed', 'file-question')
    const child = insert('failed', 'file-question')
    const prompt = join(dir, `failed-stranded-${child}.prompt.txt`)
    writeFileSync(prompt, 'original failed fixture spec')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('UPDATE run SET parent_run_id=?, turn=2, prompt_path=?, cwd=? WHERE id=?')
      .run(root, prompt, dir, child)
    db().query(
      `INSERT INTO question
        (run_id, asked_at, question, answer, answered_at, answered_by, delivery_pending_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      child, new Date().toISOString(), 'which recovery?', 'retry with the recorded ruling',
      new Date().toISOString(), 'orch-test-session', new Date().toISOString(),
    )
    expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(child))
      .toEqual({ delivery_pending_at: expect.any(String) })

    const binDir = mkdtempSync(join(tmpdir(), 'orch-failed-stranded-retry-'))
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const retried = orchInput(['retry', String(child), '--agent', 'grok'], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      })
      expect(retried.code, retried.err).toBe(0)
      const replacement = db().query('SELECT prompt_path FROM run WHERE retry_of=?').get(child) as
        { prompt_path: string }
      const resent = readFileSync(replacement.prompt_path, 'utf8')
      expect(resent).toContain('YOU ASKED: which recovery?')
      expect(resent).toContain('THE RULING: retry with the recorded ruling')
      expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(child))
        .toEqual({ delivery_pending_at: null })
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('a recorded-ruling writing retry warns that prior partial edits are not carried', () => {
    const id = insert('asking', 'implement')
    const prompt = join(dir, `record-only-writing-${id}.prompt.txt`)
    writeFileSync(prompt, 'original implementation spec')
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(),
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    db().query('UPDATE run SET session_id=?, vendor_session=?, prompt_path=?, cwd=? WHERE id=?')
      .run('orch-test-session', 'valid-session', prompt, process.cwd(), id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
    expect(orch('answer', String(id), '--record-only', 'use the existing shape').code).toBe(0)

    const binDir = mkdtempSync(join(tmpdir(), 'orch-writing-warning-retry-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 99\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    try {
      const retried = orchInput(['retry', String(id)], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      })
      expect(retried.code).toBe(1)
      expect(retried.err).toContain(
        'recorded rulings require a fresh worktree; retry will not carry the previous partial edit',
      )
      expect(retried.err).toContain(
        "this project's branch names must carry a ticket key ({key}-orch-{id})",
      )
      expect((db().query('SELECT COUNT(*) n FROM run WHERE retry_of=?').get(id) as { n: number }).n)
        .toBe(0)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('answer resumes the agent from the same row as the fallback vendor session', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-answer-fallback-agent-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('asking', 'file-question')
    db().query('UPDATE run SET session_id=?, vendor_session=?, agent=?, cwd=? WHERE id=?')
      .run('orch-test-session', 'codex-session', 'codex', dir, root)
    const latest = insert('asking', 'file-question')
    db().query(
      'UPDATE run SET parent_run_id=?, turn=2, vendor_session=NULL, agent=?, cwd=? WHERE id=?',
    ).run(root, 'grok', dir, latest)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(latest, new Date().toISOString(), 'which shape?')
    try {
      const result = orchInput(['answer', String(root), 'use the existing shape'], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      })
      expect(result.code).toBe(0)
      const childId = Number(result.out.match(/as run (\d+)/)?.[1])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const resumed = db().query(
        'SELECT agent, vendor_session FROM run WHERE parent_run_id=? AND turn=3',
      ).get(root)
      expect(resumed).toEqual({ agent: 'codex', vendor_session: 'codex-session' })
      expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(latest))
        .toEqual({ delivery_pending_at: null })
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('a resume spawn failure rolls the ruling back and leaves the question open', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=?, vendor_session=? WHERE id=?')
      .run('orch-test-session', 'fixture-vendor-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')

    const result = orchInput(['answer', String(id), 'use the existing shape'], undefined, {
      ORCH_EXEC_PATH: join(dir, 'definitely-missing-orch-exec'),
    })

    expect(result.code).toBe(1)
    expect(result.err).toContain('Resume failed:')
    expect(result.err).toContain('The ruling was rolled back and the question is still open.')
    expect(db().query(
      'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
    ).get(id)).toEqual({ answer: null, answered_by: null, answered_at: null })
  })

  test('result surfaces the recorded base commit for a writing run', () => {
    const id = insert('ok', 'implement')
    db().query('UPDATE run SET base_commit=? WHERE id=?').run('base-commit-123', id)
    const r = orch('result', String(id))
    expect(r.code).toBe(0)
    expect(r.err).toContain('base:      base-commit-123')
  })

  test('result and runs flag only slow, thin, non-probe answer output', () => {
    const fixture = (latency: number, probe = 0) => {
      const id = addRun({ agent: 'codex', job: 'diagnose', latency, probe })
      const output = join(dir, `thin-output-${id}.txt`)
      writeFileSync(output, 'x'.repeat(600))
      db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
      return id
    }
    const thin = fixture(400_000)
    const fast = fixture(300_000)
    const probe = fixture(400_000, 1)
    const warning = 'thin: 600 B after 6m40s — check whether the run stopped at a blocker'

    expect(orch('result', String(thin)).err).toContain(warning)
    expect(orch('result', String(fast)).err).not.toContain('thin:')
    expect(orch('result', String(probe)).err).not.toContain('thin:')

    const json = orch('runs', '--json', '--id', String(thin))
    expect(json.code).toBe(0)
    expect(Object.keys(runJson(json.out)).sort()).toEqual([
      'agent', 'answer_agent', 'branch', 'branch_kept', 'branch_kept_tip', 'cwd',
      'delivery', 'error', 'evidence_excluded', 'exit_code', 'failover_chain', 'failure_kind', 'head_commit', 'id',
      'idle', 'idle_ms', 'input_tree', 'job', 'last_event_at', 'latency_ms', 'launch_key', 'probe', 'prompt_head',
      'prompt_path', 'quality', 'questions', 'repo', 'requested_id', 'resolved_from', 'retry_of', 'review_ref', 'route_reason',
      'sandbox', 'session_id', 'started_at', 'status', 'turns', 'vendor_cost_usd', 'vendor_tokens',
    ].sort())

    const listed = orch('runs')
    expect(listed.out).toContain(warning)
    expect(listed.out.match(/thin:/g)).toHaveLength(1)
  }, 20_000)

  test('a thin output expiring between exists and stat suppresses only the warning', () => {
    const id = addRun({ agent: 'codex', job: 'diagnose', latency: 400_000 })
    const output = join(dir, `expiring-thin-output-${id}.txt`)
    writeFileSync(output, 'x'.repeat(600))
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)

    const result = orchInput(
      ['result', String(id)], undefined,
      { ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT: output },
    )
    expect(result.code).toBe(0)
    expect(result.err).not.toContain('thin:')
    expect(existsSync(output)).toBe(false)
  })

  test('runs shows asking in the status column', () => {
    const id = insert('asking', 'implement')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
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
    expect(json.out.trim().split('\n').map((line) => runJson(line).id)).toEqual([root])
  })

  test('runs --unscored applies its filter before --limit', () => {
    const older = [
      addRun({ agent: 'codex', job: 'understand' }),
      addRun({ agent: 'grok', job: 'understand' }),
    ]
    const newer = [
      addRun({ agent: 'codex', job: 'understand' }),
      addRun({ agent: 'grok', job: 'understand' }),
      addRun({ agent: 'codex', job: 'understand' }),
    ]
    for (const id of newer) score(id, 'full', 'right')

    const result = orch('runs', '--unscored', '--json', '--limit', '2')
    expect(result.code, result.err).toBe(0)
    expect(result.out.trim().split('\n').filter(Boolean).map(runJson).map((row) => row.id))
      .toEqual(older.reverse())
  })

  test('runs --id returns the union requested and reports unknown ids', () => {
    const first = insert('ok', 'implement')
    insert('ok', 'implement')
    const second = insert('running', 'review-lens')
    const unknown = second + 1000

    const result = orch('runs', '--id', String(first), '--id', String(second),
      '--id', String(unknown), '--json')
    expect(result.code).toBe(0)
    const rows = result.out.trim().split('\n').map(runJson)
    expect(rows.map((row) => row.id)).toEqual([second, first, unknown])
    expect(rows.slice(0, 2).map((row) => [row.requested_id, row.resolved_from])).toEqual([
      [second, 'root'], [first, 'root'],
    ])
    expect(rows.at(-1)).toEqual({ id: unknown, status: 'unknown', unknown: true })
  })

  test('runs --id identifies a requested turn while returning its chain root', () => {
    const root = insert('asking', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const json = orch('runs', '--id', String(turn), '--json')
    expect(json.code).toBe(0)
    expect(runJson(json.out)).toMatchObject({
      id: root, requested_id: turn, resolved_from: 'turn',
    })

    const text = orch('runs', '--id', String(turn))
    expect(text.code).toBe(0)
    expect(text.out).toContain(`${root} (asked as turn ${turn})`)
  })

  test('runs --id preserves both requested identities when they resolve to one root', () => {
    const root = insert('asking', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const result = orch('runs', '--id', String(root), '--id', String(turn), '--json')
    expect(result.code).toBe(0)
    expect(result.out.trim().split('\n').map((line) => {
      const row = runJson(line)
      return [row.id, row.requested_id, row.resolved_from]
    })).toEqual([
      [root, root, 'root'],
      [root, turn, 'turn'],
    ])
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
    const [row] = result.out.trim().split('\n').map(runJson)
    expect(row.id).toBe(root)
    expect(row.status).toBe('ok')
    expect(row.turns.map((turn: { id: number }) => turn.id)).toEqual(ids)
    expect(row.turns.reduce(
      (sum: number, turn: { vendor_tokens: number }) => sum + turn.vendor_tokens, 0,
    )).toBe(11_798_623)
  })

  test('runs --json --since includes a chain whose only recent fact is a question', () => {
    const cutoff = '2026-09-04T18:00:00.000Z'
    const old = addRun({
      agent: 'codex', job: 'implement', status: 'asking',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(old, '2026-09-04T19:55:00.000Z', 'need a ruling')

    const json = orch('runs', '--json', '--since', cutoff)
    expect(json.code).toBe(0)
    const rows = json.out.trim().split('\n').map(runJson) as {
      id: number
      questions: { asked_at: string; answered_at: string | null }[]
    }[]
    expect(rows.map((row) => row.id)).toEqual([old])
    expect(rows[0]!.questions).toEqual([expect.objectContaining({
      asked_at: '2026-09-04T19:55:00.000Z', answered_at: null,
    })])
  })

  test('runs --json --since republishes a question answered with no new turn', () => {
    const cutoff = '2026-09-04T18:00:00.000Z'
    const old = addRun({
      agent: 'codex', job: 'implement', status: 'ok',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db().query(
      'INSERT INTO question (run_id, asked_at, question, answered_at) VALUES (?,?,?,?)',
    ).run(old, '2026-09-04T16:00:00.000Z', 'need a ruling', '2026-09-04T19:55:00.000Z')

    const json = orch('runs', '--json', '--since', cutoff)
    expect(json.code).toBe(0)
    const rows = json.out.trim().split('\n').map(runJson) as {
      id: number
      questions: { answered_at: string | null }[]
    }[]
    expect(rows.map((row) => row.id)).toEqual([old])
    expect(rows[0]!.questions[0]!.answered_at).toBe('2026-09-04T19:55:00.000Z')
  })

  test('runs --json --since still publishes an unanswered question older than the cutoff', () => {
    const cutoff = '2026-09-04T18:00:00.000Z'
    const old = addRun({
      agent: 'codex', job: 'implement', status: 'asking',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(old, '2026-09-04T16:00:00.000Z', 'still waiting')

    const json = orch('runs', '--json', '--since', cutoff)
    expect(json.code).toBe(0)
    expect(json.out.trim().split('\n').map((line) => runJson(line).id)).toEqual([old])
  })

  test('runs --json publishes the root launch_key', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    db().query('UPDATE run SET launch_key=? WHERE id=?').run('DEV-7777', id)
    const json = orch('runs', '--json', '--id', String(id))
    expect(json.code).toBe(0)
    expect(runJson(json.out.trim().split('\n')[0]!).launch_key).toBe('DEV-7777')
  })

  test('runs --json publishes the same evidence exclusion as run detail', () => {
    const id = addRun({ agent: 'codex', job: 'understand', status: 'ok' })
    db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run('operator void', id)

    const listed = orch('runs', '--json', '--id', String(id))
    const detail = orch('run', String(id))
    expect(listed.code).toBe(0)
    expect(detail.code).toBe(0)
    expect(runJson(listed.out.trim()).evidence_excluded)
      .toBe(JSON.parse(detail.out).evidence_excluded)
    expect(runJson(listed.out.trim()).evidence_excluded).toBe('operator void')
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

  test('a failed run wraps partial JSON so it cannot parse as a completed review', () => {
    const id = insert('failed', 'review-lens')
    const output = join(dir, `failed-partial-${id}.txt`)
    const partial = {
      findings: [],
      provenance: { tree_inspected: 'Found two invalidators.', could_not_verify: [] },
    }
    writeFileSync(output, JSON.stringify(partial))
    db().query(
      `UPDATE run SET output_path=?, error='agent died', failure_kind='interrupted', exit_code=1
        WHERE id=?`,
    ).run(output, id)

    const r = orch('result', String(id))

    expect(r.code).toBe(1)
    expect(r.err).toContain(`INCOMPLETE partial output from run ${id} (failed) follows`)
    expect(r.err).toContain(`run ${id} failed: interrupted, exit 1: agent died`)
    const shown = JSON.parse(r.out)
    expect(shown).toEqual({
      run: {
        id, status: 'failed', complete: false,
        failure_kind: 'interrupted', exit_code: 1,
      },
      partial_output: partial,
    })
    expect(shown.findings).toBeUndefined()
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(partial)
  })

  test('result falls back to the run row and output when the full CLI cannot parse', () => {
    const id = insert('ok')
    const output = join(dir, `degraded-result-${id}.txt`)
    writeFileSync(output, 'already-paid-for answer')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)

    const shadow = join(dir, 'degraded-result-cli')
    writeDegradedShadow(shadow)

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
    writeDegradedShadow(shadow)

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

  test("score --void accepts only a harness-failed '(pending)' run", () => {
    const harness = insert('failed')
    db().query("UPDATE run SET agent='(pending)', failure_kind='harness' WHERE id=?").run(harness)
    const voided = orch('score', String(harness), 'none', '--void')
    expect(voided.code).toBe(0)
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(harness))
      .toEqual({ evidence_excluded: 'voided with orch score --void' })
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(harness)).toBeNull()

    const other = insert('failed')
    db().query("UPDATE run SET agent='(pending)', failure_kind='other' WHERE id=?").run(other)
    const refused = orch('score', String(other), 'none', '--void')
    expect(refused.code).toBe(1)
    expect(refused.err).toContain("agent is the placeholder '(pending)'")
  })

  test('only a live hub serve capability lets the dashboard scorer cross ownership', async () => {
    const id = insert('ok', 'file-question')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', id)

    const forged = orchInput(['score', String(id), 'full', 'right', '--scorer', 'forged-dashboard'],
      undefined, { CLAUDE_CODE_SESSION_ID: 'foreign-session' })
    expect(forged.code).toBe(1)
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()

    const capabilityDir = mkdtempSync(join(tmpdir(), 'hub-dashboard-test-'))
    chmodSync(capabilityDir, 0o700)
    const capabilityPath = join(capabilityDir, 'score-capability.json')
    const capabilityBin = join(capabilityDir, 'bin')
    mkdirSync(capabilityBin)
    writeFileSync(join(capabilityBin, 'ps'), '#!/bin/sh\necho "bun /repo/hub/src/cli.ts serve --port 7778"\n')
    chmodSync(join(capabilityBin, 'ps'), 0o755)
    const token = randomUUID()
    const hub = Bun.spawn(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)', 'hub', 'serve'],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    writeFileSync(capabilityPath, JSON.stringify({ token, pid: hub.pid }), { mode: 0o600 })
    chmodSync(capabilityPath, 0o600)
    try {
      const invalid = orchInput(
        ['score', String(id), 'full', 'right', '--scorer', 'hub-dashboard'], undefined,
        {
          CLAUDE_CODE_SESSION_ID: 'foreign-session',
          [DASHBOARD_CAPABILITY_PATH_ENV]: capabilityPath,
          [DASHBOARD_CAPABILITY_TOKEN_ENV]: 'not-the-token',
          PATH: `${capabilityBin}:${process.env.PATH ?? ''}`,
        },
      )
      expect(invalid.code).toBe(1)

      const forbiddenVoid = orchInput(
        ['score', String(id), '--void', '--scorer', 'hub-dashboard'], undefined,
        {
          CLAUDE_CODE_SESSION_ID: 'foreign-session',
          [DASHBOARD_CAPABILITY_PATH_ENV]: capabilityPath,
          [DASHBOARD_CAPABILITY_TOKEN_ENV]: token,
          PATH: `${capabilityBin}:${process.env.PATH ?? ''}`,
        },
      )
      expect(forbiddenVoid.code).toBe(1)
      expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id))
        .toEqual({ evidence_excluded: null })

      const allowed = orchInput(
        ['score', String(id), 'full', 'right', '--scorer', 'hub-dashboard'], undefined,
        {
          CLAUDE_CODE_SESSION_ID: 'foreign-session',
          [DASHBOARD_CAPABILITY_PATH_ENV]: capabilityPath,
          [DASHBOARD_CAPABILITY_TOKEN_ENV]: token,
          PATH: `${capabilityBin}:${process.env.PATH ?? ''}`,
        },
      )
      expect(allowed.code).toBe(0)
      expect(db().query('SELECT scored_by FROM score WHERE run_id=?').get(id))
        .toEqual({ scored_by: 'hub-dashboard' })
    } finally {
      hub.kill()
      await hub.exited
      rmSync(capabilityDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('an anonymous caller cannot score an unowned run', () => {
    const id = insert('ok', 'file-question')
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'score', String(id), 'full', 'right'],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_BRIDGE_SESSION_ID: undefined },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('CLAUDE_CODE_SESSION_ID is not set')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('only the bridge id cannot score an unowned run', () => {
    const id = insert('ok', 'file-question')
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'score', String(id), 'full', 'right'],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_BRIDGE_SESSION_ID: 'shared-bridge' },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('CLAUDE_CODE_SESSION_ID is not set')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('bridge-only --force scores an unowned run without adopting', () => {
    const id = insert('ok', 'file-question')
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'score', String(id), 'full', 'right', '--force'],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_BRIDGE_SESSION_ID: 'shared-bridge' },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(0)
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(id))
      .toEqual({ session_id: null })
    expect(db().query('SELECT delivery, quality FROM score WHERE run_id=?').get(id))
      .toEqual({ delivery: 'full', quality: 'right' })
    expect(db().query(
      'SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=? ORDER BY rowid',
    ).all(id)).toEqual([
      { action: 'score', actor_session: null, reason: '--force' },
    ])
  })

  test('the first score adopts an unowned root and refuses foreign rescore and void', () => {
    const id = insert('ok', 'file-question')
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(id)

    const first = orchInput(['score', String(id), 'full', 'right'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-A',
    })
    expect(first.code).toBe(0)
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(id))
      .toEqual({ session_id: 'session-A' })
    expect(db().query(
      `SELECT action, actor_session, reason FROM run_mutation_audit
        WHERE root_id=? ORDER BY rowid`,
    ).all(id)).toEqual([
      { action: 'adopt', actor_session: 'session-A', reason: 'before score' },
      { action: 'score', actor_session: 'session-A', reason: null },
    ])

    const rescore = orchInput(['score', String(id), 'partial', 'mixed'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    })
    expect(rescore.code).toBe(1)
    expect(rescore.err).toContain('its session:   session-A')
    const voided = orchInput(['score', String(id), '--void'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    })
    expect(voided.code).toBe(1)
    expect(voided.err).toContain(`run ${id} is owned by session session-A`)
    expect(db().query('SELECT delivery, quality FROM score WHERE run_id=?').get(id))
      .toEqual({ delivery: 'full', quality: 'right' })
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id))
      .toEqual({ evidence_excluded: null })
  }, 20_000)

  test('score drops a habitual fidelity word for a review lens and records two axes', () => {
    const id = insert('ok', 'review-lens')
    const output = join(dir, `graded-review-${id}.json`)
    writeFileSync(output, JSON.stringify(reviewReply(1)))
    db().query('UPDATE run SET session_id=?, lens=?, model=?, output_path=? WHERE id=?')
      .run('orch-test-session', 'correctness', 'test-model', output, id)
    expect(orch('pending').code).toBe(1)

    const r = orch('score', String(id), 'full', 'right', 'faithful',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'absent',
      '--overlap', 'alone')
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      'review-lens has no spec to be faithful to, so it is judged on two axes only',
    )
    expect(r.out).toContain(`scored full right  [1]`)
    expect(db().query(
      'SELECT delivery, quality, fidelity FROM score WHERE run_id=?',
    ).get(id)).toEqual({ delivery: 'full', quality: 'right', fidelity: null })
    expect(db().query(
      'SELECT reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
    ).get(id)).toEqual({ reproduced: 'all', coverage: 'adequate', limits: 'absent', overlap: 'alone' })
    expect(orch('score', String(id), 'partial', 'mixed', '--scorer', 'dashboard-user',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'absent',
      '--overlap', 'alone').code).toBe(0)
    expect(db().query(
      'SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=? ORDER BY at, rowid',
    ).all(id)).toEqual([
      { action: 'score', actor_session: 'orch-test-session', reason: null },
      { action: 'rescore', actor_session: 'orch-test-session', reason: '--scorer dashboard-user' },
    ])
    expect(orch('pending').code).toBe(0)
  }, 20_000)

  test('lens scoring refuses missing grades with the canonical vocabulary and writes nothing', () => {
    const id = insert('ok', 'review-lens')
    const output = join(dir, `ungraded-review-${id}.json`)
    writeFileSync(output, JSON.stringify(reviewReply(1)))
    db().query('UPDATE run SET session_id=?, lens=?, model=?, output_path=? WHERE id=?')
      .run('orch-test-session', 'safety', 'test-model', output, id)

    const r = orch('score', String(id), 'full', 'right')

    expect(r.code).toBe(1)
    expect(r.err).toContain('--reproduced none | some | all')
    expect(r.err).toContain('--coverage   empty | partial | adequate')
    expect(r.err).toContain('--limits     named | absent')
    expect(r.err).toContain('--overlap    unique | shared | none | alone')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
    expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(id)).toBeNull()
  })

  test('lens scoring updates an already-recorded review row instead of creating another review', () => {
    const id = addRun({ agent: 'codex', job: 'safety', model: 'm', lens: 'existing',
      session: 'orch-test-session' })
    const reviewId = recordReview(id, reviewReply(1))
    const before = (db().query('SELECT COUNT(*) AS n FROM review').get() as { n: number }).n
    const r = orch('score', String(id), 'partial', 'mixed',
      '--reproduced', 'some', '--coverage', 'partial', '--limits', 'named', '--overlap', 'shared')
    expect(r.code).toBe(0)
    expect((db().query('SELECT COUNT(*) AS n FROM review').get() as { n: number }).n).toBe(before)
    expect(db().query(
      'SELECT review_id, reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
    ).get(id)).toEqual({
      review_id: reviewId, reproduced: 'some', coverage: 'partial', limits: 'named', overlap: 'shared',
    })
  })

  test('an empty lens defaults reproduced and overlap while delivery none captures nothing', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-empty-lens-score-')))
    const git = (...args: string[]) => {
      const child = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (child.exitCode !== 0) throw new Error(child.stderr.toString())
      return child.stdout.toString().trim()
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git('add', '.'); git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file.ts'), 'changed\n')
    git('add', '.'); git('commit', '-m', 'change')
    const tree = git('rev-parse', 'HEAD^{tree}')
    const project = `empty-lens-${randomUUID()}`
    upsertProject({ name: project, path: repo })
    try {
    const empty = insert('ok', 'craft')
    const output = join(dir, `empty-review-${empty}.json`)
    writeFileSync(output, JSON.stringify(reviewReply(0)))
    db().query(
      'UPDATE run SET session_id=?, lens=?, model=?, output_path=?, repo=?, base_commit=?, input_tree=? WHERE id=?',
    ).run('orch-test-session', 'craft', 'test-model', output, project, base, tree, empty)
    const scored = orch('score', String(empty), 'full', 'right',
      '--coverage', 'partial', '--limits', 'named')
    expect(scored.code).toBe(0)
    expect(db().query(
      'SELECT reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
    ).get(empty)).toEqual({ reproduced: 'none', coverage: 'partial', limits: 'named', overlap: 'none' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }

    const failed = insert('failed', 'safety')
    db().query("UPDATE run SET session_id=?, failure_kind='other' WHERE id=?")
      .run('orch-test-session', failed)
    expect(orch('score', String(failed), 'none').code).toBe(0)
    expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(failed)).toBeNull()

    const rejectedRun = insert('failed', 'craft')
    db().query("UPDATE run SET failure_kind='other' WHERE id=?").run(rejectedRun)
    const rejectedFlags = orch('score', String(rejectedRun), 'none',
      '--reproduced', 'none')
    expect(rejectedFlags.code).toBe(1)
    expect(rejectedFlags.err).toContain("delivery 'none' takes no review grades")
  }, 20_000)

  test('score refuses an unevidenced clean lens without creating score or review rows', () => {
    const id = insert('ok', 'review-lens')
    const output = join(dir, `unevidenced-review-${id}.json`)
    const reply = reviewReply(0) as any
    reply.provenance.files_covered = []
    reply.provenance.commands_run = []
    writeFileSync(output, JSON.stringify(reply))
    db().query('UPDATE run SET session_id=?, lens=?, model=?, output_path=? WHERE id=?')
      .run('orch-test-session', 'empty', 'test-model', output, id)

    const result = orch('score', String(id), 'full', 'right',
      '--coverage', 'empty', '--limits', 'named')
    expect(result.code).toBe(1)
    expect(result.err).toContain('clean review with no evidence')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
    expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(id)).toBeNull()
  })

  test('score refuses review grades on a job that does not produce findings', () => {
    const id = insert('ok', 'file-question')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    const r = orch('score', String(id), 'full', 'right',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named', '--overlap', 'unique')
    expect(r.code).toBe(1)
    expect(r.err).toContain('file-question is not a findings-producing lens')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('duplicate singleton review grades are refused without recording a score or review', () => {
    const cases = [
      { extra: ['--reproduced', 'all'], message: '--reproduced', values: ['all', 'all'] },
      { extra: ['--coverage', 'empty'], message: '--coverage', values: ['adequate', 'empty'] },
      { extra: ['--reproduced', 'banana'], message: '--reproduced', values: ['all', 'banana'] },
    ]
    for (const [index, duplicate] of cases.entries()) {
      const id = insert('ok', 'review-lens')
      const output = join(dir, `duplicate-grade-${index}-${id}.json`)
      writeFileSync(output, JSON.stringify(reviewReply(1)))
      db().query('UPDATE run SET session_id=?, lens=?, model=?, output_path=? WHERE id=?')
        .run('orch-test-session', 'duplicate-grade', 'test-model', output, id)
      const r = orch('score', String(id), 'full', 'right',
        '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named',
        '--overlap', 'unique', ...duplicate.extra)
      expect(r.code).toBe(1)
      expect(r.err).toContain(`${duplicate.message} may be supplied only once`)
      for (const value of duplicate.values) expect(r.err).toContain(JSON.stringify(value))
      expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
      expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(id)).toBeNull()
    }
  }, 20_000)

  test('review triage --severity stores explicit agreement and omission stores null', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'triage-cli' })
    const reviewId = recordReview(runId, reviewReply(2, 'high'))
    expect(orch('review', 'triage', String(reviewId), '1', 'accepted', '--severity', 'high').code).toBe(0)
    expect(orch('review', 'triage', String(reviewId), '2', 'accepted').code).toBe(0)
    expect(db().query(
      'SELECT ordinal, triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal',
    ).all(reviewId)).toEqual([
      { ordinal: 1, triaged_severity: 'high' },
      { ordinal: 2, triaged_severity: null },
    ])
    const invalid = orch('review', 'triage', String(reviewId), '2', 'accepted', '--severity', 'banana')
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain('critical | high | medium | low')
  }, 20_000)

  test('duplicate triage severity is refused without changing the finding', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'triage-duplicate' })
    const reviewId = recordReview(runId, reviewReply(1))
    const r = orch('review', 'triage', String(reviewId), '1', 'accepted',
      '--severity', 'critical', '--severity', 'banana')
    expect(r.code).toBe(1)
    expect(r.err).toContain('--severity may be supplied only once')
    expect(r.err).toContain('"critical" and "banana"')
    expect(db().query(
      'SELECT disposition, triaged_severity, triaged_at FROM review_finding WHERE review_id=?',
    ).get(reviewId)).toEqual({ disposition: null, triaged_severity: null, triaged_at: null })
  })

  test('score refuses an owned run when the caller has no session identity', () => {
    const id = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', id)
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'score', String(id), 'full', 'right'],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_BRIDGE_SESSION_ID: undefined },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('no session identity is present')
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('doctor excludes scores on not-evidence runs from its scored count', () => {
    score(insert('ok'), 'full', 'right')
    const interrupted = insert('failed')
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    score(interrupted, 'none')

    const r = orch('doctor')
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs 2, scored 1, voided 0, unscored 0')
  })

  test('doctor reports a voided verdict separately from scored routing evidence', () => {
    score(insert('ok'), 'full', 'right')
    const voided = insert('ok')
    score(voided, 'full', 'right')
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(voided)

    const r = orch('doctor')
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs 2, scored 1, voided 1, unscored 0')
  })

  test('a no-verdict void is accounted for by doctor and state totals, which agree', () => {
    const kept = insert('ok')
    score(kept, 'full', 'right')
    const voidedWithVerdict = insert('ok')
    score(voidedWithVerdict, 'full', 'right')
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(voidedWithVerdict)
    const noVerdict = insert('ok')
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(noVerdict)

    const r = orch('doctor')
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs 3, scored 1, voided 2, unscored 0')
    const totals = state(null).totals as { runs: number; scored: number; voided: number }
    expect(totals).toEqual(expect.objectContaining({ runs: 3, scored: 1, voided: 2 }))
    expect(state(null).unscored).toBe(0)
  })

  test('a voided not-evidence run is voided, not dropped from every bucket', () => {
    const interrupted = insert('failed')
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(interrupted)

    const r = orch('doctor')
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs 1, scored 0, voided 1, unscored 0')
    expect(state(null).totals as { scored: number; voided: number }).toEqual(
      expect.objectContaining({ scored: 0, voided: 1 }),
    )
  })

  test('doctor lists orphaned run containers and volumes with removal commands', () => {
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'adanim' })
    db().query('UPDATE run SET worktree=? WHERE id=?')
      .run(`/tmp/missing/orch-${id}`, id)
    const docker = fakeDocker(
      [`orch-${id}-postgres-1`, 'ordinary-container'],
      [`orch-${id}_adanim-pgdata`, 'ordinary-volume'],
    )
    try {
      const p = Bun.spawnSync([process.execPath, CLI, 'doctor'], {
        env: {
          ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!,
          ORCH_DEPTH: '0', ORCH_LOCAL_BASE_URL: '',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const out = p.stdout.toString()
      expect(p.exitCode).toBe(0)
      expect(out).toContain('docker orphans  2')
      expect(out).toContain(`container orch-${id}-postgres-1 — project adanim, run ${id}`)
      expect(out).toContain(`docker rm -f orch-${id}-postgres-1`)
      expect(out).toContain(`volume orch-${id}_adanim-pgdata — project adanim, run ${id}`)
      expect(out).toContain(`docker volume rm orch-${id}_adanim-pgdata`)
      expect(out).not.toContain('ordinary-container')
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('doctor prints every CLI version and warns below its recorded minimum', () => {
    upsertProject({ name: PLATFORM_SLUG, path: '/registered/platform' })
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
    expect(out).toContain(`database       ${process.env.ORCH_DB}`)
    expect(out).toContain('resolved by    ORCH_DB')
    expect(out).toContain('registered     /registered/platform/orchestrator/orch.db  (resolved path won)')
    for (const version of Object.values(versions)) expect(out).toContain(`version ${version}`)
    expect(out).toContain('WARNING: codex 0.150.0 is below minimum 0.153.4')
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

  test('an explicit base without a {base} slot is not refused at preflight', () => {
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
    expect(r.err).not.toContain('cannot honour --base')
    expect(r.err).not.toContain('has no {base} slot')
  })

  test('non-commit bases are refused before every dispatch artifact', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-non-commit-base-')))
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'fixture')
      upsertProject({
        name: 'commit-bases-only', path: repo, canon: false,
        settings: { worktree: { recipe: {}, branch: 'task/{id}' } },
      })
      const refs: [string, string][] = [
        ['0123456789012345678901234567890123456789', 'Needed a single revision'],
        [git(repo, 'rev-parse', 'HEAD^{tree}'), 'tree'],
        [git(repo, 'hash-object', 'tracked.txt'), 'blob'],
      ]
      for (const [ref, kind] of refs) {
        const before = dispatchArtifacts(repo)
        const r = orchFrom(
          repo, 'orch-test-session', 'do', 'implement', 'inspect', '--base', ref, '--porcelain',
        )
        expect(r.code, ref).not.toBe(0)
        expect(r.err, ref).toContain(ref)
        expect(r.err, ref).toContain(kind)
        expectNoDispatchArtifacts(repo, before)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)


  test('scoring same-tree roots offers a pair and --worse-than records the inverse duel', () => {
    const first = addRun({ agent: 'codex', job: 'file-question', session: 'orch-test-session', inputTree: 'tree' })
    const second = addRun({ agent: 'grok', job: 'file-question', session: 'orch-test-session', inputTree: 'tree' })
    expect(orch('score', String(first), 'full', 'right').out).not.toContain('pair:')

    const offered = orch('score', String(second), 'full', 'right')
    expect(offered.code).toBe(0)
    expect(offered.out).toContain(
      `pair: run ${first} (codex) is comparable (same task prompt; same input tree) — record with --better-than ${first} | ` +
      `--worse-than ${first} | --same-as ${first}`,
    )
    expect(orch('score', String(second), 'full', 'right', '--worse-than', String(first)).code).toBe(0)
    expect(db().query(
      'SELECT winner_run_id, loser_run_id FROM duel',
    ).all()).toEqual([{ winner_run_id: first, loser_run_id: second }])
    expect(orch('pending').out).not.toContain(`--same-as ${first}`)
  })


  test('--same-as marks a scored pair compared without adding a duel', () => {
    const first = addRun({ agent: 'codex', job: 'file-question', session: 'orch-test-session', inputTree: 'tie-tree' })
    const second = addRun({ agent: 'grok', job: 'file-question', session: 'orch-test-session', inputTree: 'tie-tree' })
    expect(orch('score', String(first), 'full', 'right').code).toBe(0)
    expect(orch('score', String(second), 'full', 'right', '--same-as', String(first)).code).toBe(0)
    expect(db().query('SELECT COUNT(*) n FROM duel').get()).toEqual({ n: 0 })
    expect(db().query('SELECT run_a_id, run_b_id FROM compared_pair').all())
      .toEqual([{ run_a_id: first, run_b_id: second }])
    expect(orch('pending').out).not.toContain(`--same-as ${first}`)
  })


  test('inline roots with the same task-prompt hash are offered as partners', () => {
    const first = addRun({ agent: 'codex', job: 'summarize', session: 'orch-test-session' })
    const second = addRun({ agent: 'grok', job: 'summarize', session: 'orch-test-session' })
    expect(orch('score', String(first), 'full', 'right').code).toBe(0)
    const scored = orch('score', String(second), 'full', 'right')
    expect(scored.code).toBe(0)
    expect(scored.out).toContain(`pair: run ${first} (codex) is comparable (same task prompt; at least one input tree unrecorded)`)
  })

  test('judge closes a two-finding review and pair in one transaction', () => {
    const partner = addRun({
      agent: 'codex', job: 'review-lens', session: 'orch-test-session',
      inputTree: 'judge-tree', lens: 'correctness', promptSha: 'bound-codex', specSha: 'same-task',
    })
    score(partner, 'full', 'right')
    const subject = addRun({
      agent: 'grok', job: 'review-lens', session: 'orch-test-session',
      inputTree: 'judge-tree', lens: 'correctness', promptSha: 'bound-grok', specSha: 'same-task',
    })
    const reviewId = recordReview(subject, reviewReply(2, 'high'))

    const judged = orch(
      'judge', String(subject), 'full', 'right',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named',
      '--overlap', 'unique', '--finding', '1=accepted:high',
      '--finding', '2=rejected:below-bar', '--worse-than', String(partner),
    )
    expect(judged.code).toBe(0)
    expect(db().query('SELECT delivery, quality FROM score WHERE run_id=?').get(subject))
      .toEqual({ delivery: 'full', quality: 'right' })
    expect(db().query(
      'SELECT reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
    ).get(subject)).toEqual({ reproduced: 'all', coverage: 'adequate', limits: 'named', overlap: 'unique' })
    expect(db().query(
      'SELECT ordinal, disposition, rejection_category, triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal',
    ).all(reviewId)).toEqual([
      { ordinal: 1, disposition: 'accepted', rejection_category: null, triaged_severity: 'high' },
      { ordinal: 2, disposition: 'rejected', rejection_category: 'below-bar', triaged_severity: null },
    ])
    expect(db().query('SELECT completed_at IS NOT NULL AS complete FROM review WHERE id=?').get(reviewId))
      .toEqual({ complete: 1 })
    expect(db().query('SELECT winner_run_id, loser_run_id FROM duel').all())
      .toContainEqual({ winner_run_id: partner, loser_run_id: subject })
  })

  test('judge rolls every close-out write back when a finding flag fails during the transaction', () => {
    const subject = addRun({
      agent: 'grok', job: 'review-lens', session: 'orch-test-session',
      lens: 'rollback', promptSha: 'rollback-task',
    })
    const reviewId = recordReview(subject, reviewReply(2, 'high'))
    const judged = orch(
      'judge', String(subject), 'full', 'right',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named',
      '--overlap', 'unique', '--finding', '1=accepted:high',
      '--finding', '2=rejected:NOT-A-STABLE-ID',
    )
    expect(judged.code).not.toBe(0)
    expect(db().query('SELECT 1 FROM score WHERE run_id=?').get(subject)).toBeNull()
    expect(db().query(
      'SELECT reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
    ).get(subject)).toEqual({ reproduced: null, coverage: null, limits: null, overlap: null })
    expect(db().query('SELECT disposition FROM review_finding WHERE review_id=?').all(reviewId))
      .toEqual([{ disposition: null }, { disposition: null }])
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(reviewId))
      .toEqual({ completed_at: null })
  })

  test('judge closes a writer score with fidelity', () => {
    const subject = addRun({
      agent: 'codex', job: 'implement', session: 'orch-test-session', promptSha: 'writer-task',
    })
    const judged = orch('judge', String(subject), 'full', 'right', 'faithful', '--note', 'matched spec')
    expect(judged.code).toBe(0)
    expect(db().query('SELECT delivery, quality, fidelity, note FROM score WHERE run_id=?').get(subject))
      .toEqual({ delivery: 'full', quality: 'right', fidelity: 'faithful', note: 'matched spec' })
  })

  test('judge none closes review debt without entering reviewer calibration', () => {
    const subject = addRun({
      agent: 'grok', job: 'review-lens', session: 'none-review-session',
      lens: 'none-delivery', model: 'none-model',
    })
    const reviewId = recordReview(subject, reviewReply(2, 'high'))
    const before = reviewCalibration('none-delivery', 'grok', 'none-model')
    expect(orchInput(['pending'], undefined, { CLAUDE_CODE_SESSION_ID: 'none-review-session' }).out)
      .toContain(String(subject))
    expect(scoreReminder('none-review-session').stdout.toString()).toContain(`orch judge ${subject}`)

    const judged = orchInput(['judge', String(subject), 'none'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'none-review-session',
    })

    expect(judged.code).toBe(0)
    expect(db().query('SELECT delivery, quality FROM score WHERE run_id=?').get(subject))
      .toEqual({ delivery: 'none', quality: null })
    expect(db().query('SELECT completed_at IS NOT NULL AS complete FROM review WHERE id=?').get(reviewId))
      .toEqual({ complete: 1 })
    expect(db().query('SELECT disposition FROM review_finding WHERE review_id=? ORDER BY ordinal').all(reviewId))
      .toEqual([{ disposition: null }, { disposition: null }])
    expect(orchInput(['pending'], undefined, { CLAUDE_CODE_SESSION_ID: 'none-review-session' }).out)
      .not.toContain(String(subject))
    expect(scoreReminder('none-review-session').stdout.toString()).not.toContain(`orch judge ${subject}`)
    expect(reviewCalibration('none-delivery', 'grok', 'none-model')).toEqual(before)
  })

  test('judge lists every missing writer axis in one refusal', () => {
    const subject = addRun({
      agent: 'codex', job: 'implement', session: 'orch-test-session', promptSha: 'missing-writer',
    })
    const judged = orch('judge', String(subject))
    expect(judged.code).not.toBe(0)
    expect(judged.err).toContain(`orch judge ${subject} is missing:`)
    for (const axis of ['<none|partial|full>', '<wrong|mixed|right>', '<drifted|partial|faithful>']) {
      expect(judged.err).toContain(axis)
    }
    expect(db().query('SELECT 1 FROM score WHERE run_id=?').get(subject)).toBeNull()
  })

  test('score and judge read notes from files and reject shell-fragment notes', () => {
    const scoreRun = addRun({ agent: 'codex', job: 'file-question', session: 'orch-test-session' })
    const notePath = join(dir, 'score-note.txt')
    writeFileSync(notePath, 'long note\nwith a second line')
    expect(orch('score', String(scoreRun), 'full', 'right', '--note-file', notePath).code).toBe(0)
    expect(db().query('SELECT note FROM score WHERE run_id=?').get(scoreRun))
      .toEqual({ note: 'long note\nwith a second line' })

    const judgeRun = addRun({ agent: 'codex', job: 'implement', session: 'orch-test-session' })
    expect(orch('judge', String(judgeRun), 'full', 'right', 'faithful', '--note-file', notePath).code).toBe(0)
    const broken = addRun({ agent: 'codex', job: 'file-question', session: 'orch-test-session' })
    const refused = orch('score', String(broken), 'full', 'right', '--note', '"unfinished')
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain('unexpanded shell fragment')
    expect(refused.err).toContain('--note-file')
    expect(db().query('SELECT 1 FROM score WHERE run_id=?').get(broken)).toBeNull()
    const prose = addRun({ agent: 'codex', job: 'file-question', session: 'orch-test-session' })
    expect(orch('score', String(prose), 'full', 'right', '--note', "worker's answer").code).toBe(0)
  })

  test('the Stop hook names judge and every missing findings flag', () => {
    const subject = addRun({
      agent: 'grok', job: 'review-lens', session: 'judge-hook-session', lens: 'correctness',
    })
    recordReview(subject, reviewReply(2, 'high'))
    const reminder = scoreReminder('judge-hook-session').stdout.toString()
    expect(reminder).toContain(`orch judge ${subject}`)
    for (const flag of ['--reproduced', '--coverage', '--limits', '--overlap', '--finding 1=', '--finding 2=']) {
      expect(reminder).toContain(flag)
    }
  })

  test('same task-prompt pairs allow different trees only when one is absent and require matching lenses', () => {
    const scored = addRun({
      agent: 'codex', job: 'review-lens', session: 'orch-test-session', specSha: 'predicate',
      inputTree: 'tree-a', lens: 'correctness',
    })
    score(scored, 'full', 'right')
    const differentTree = addRun({
      agent: 'grok', job: 'review-lens', session: 'orch-test-session', specSha: 'predicate',
      inputTree: 'tree-b', lens: 'correctness',
    })
    recordReview(differentTree, reviewReply(1, 'high'))
    expect(orch('score', String(differentTree), 'full', 'right',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named', '--overlap', 'unique').out)
      .not.toContain('pair:')
    const differentLens = addRun({
      agent: 'grok', job: 'review-lens', session: 'orch-test-session', specSha: 'predicate',
      inputTree: 'tree-a', lens: 'safety',
    })
    recordReview(differentLens, reviewReply(1, 'high'))
    expect(orch('score', String(differentLens), 'full', 'right',
      '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named', '--overlap', 'unique').out)
      .not.toContain('pair:')
  })


  test('a scored probe partner is excluded from score, pending, and Stop-hook pair offers', () => {
    const probe = addRun({
      agent: 'codex', job: 'file-question', session: 'orch-test-session',
      inputTree: 'probe-tree', probe: 1,
    })
    const subject = addRun({
      agent: 'grok', job: 'file-question', session: 'orch-test-session', inputTree: 'probe-tree',
    })
    expect(orch('score', String(probe), 'full', 'right').code).toBe(0)
    expect(orch('score', String(subject), 'full', 'right').out).not.toContain('pair:')
    expect(orch('pending').out).not.toContain(`--same-as ${probe}`)
    expect(scoreReminder('orch-test-session').stdout.toString()).toBe('')
  })


  test('an evidence-excluded partner is excluded from score, pending, and Stop-hook pair offers', () => {
    const excluded = addRun({
      agent: 'codex', job: 'file-question', session: 'orch-test-session', inputTree: 'excluded-tree',
    })
    const subject = addRun({
      agent: 'grok', job: 'file-question', session: 'orch-test-session', inputTree: 'excluded-tree',
    })
    expect(orch('score', String(excluded), 'full', 'right').code).toBe(0)
    db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run('fixture exclusion', excluded)
    expect(orch('score', String(subject), 'full', 'right').out).not.toContain('pair:')
    expect(orch('pending').out).not.toContain(`--same-as ${excluded}`)
    expect(scoreReminder('orch-test-session').stdout.toString()).toBe('')
  })


  test('stats reports Bradley-Terry strengths once a job reaches MIN_SAMPLE duels', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      const winner = addRun({ agent: 'codex', job: 'craft', session: 'orch-test-session' })
      const loser = addRun({ agent: 'grok', job: 'craft', session: 'orch-test-session' })
      recordDuels(winner, [loser], 'orch-test-session', new Date().toISOString())
    }
    const stats = orch('stats', '--job', 'craft')
    expect(stats.code).toBe(0)
    expect(stats.out).toContain(`craft Bradley-Terry strengths (${MIN_SAMPLE} duels)`)
    expect(stats.out).toContain('codex')
    expect(stats.out).not.toContain('wins-losses')
  })


  test('doctor prints latest calibration axes and reminds at age and score thresholds', () => {
    const calibrated = addRun({ agent: 'codex', job: 'file-question' })
    db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right',?,'claude')`,
    ).run(calibrated, '2026-01-01T00:00:00.000Z')
    db().query(
      `INSERT INTO calibration (run_id, delivery, quality, fidelity, at, session_id)
       VALUES (?,'full','right',NULL,?,?)`,
    ).run(calibrated, '2026-01-02T00:00:00.000Z', 'calibration-session')

    const aged = orch('doctor')
    expect(aged.code).toBe(0)
    expect(aged.out).toContain('delivery n=1 kappa=n/a ac1=1.000')
    expect(aged.out).toContain('quality  n=1 kappa=n/a ac1=1.000')
    expect(aged.out).toContain('recalibrate: 0 scores since last blind check; run orch recalibrate --n 12')

    const recent = new Date().toISOString()
    db().query('UPDATE calibration SET at=?').run(recent)
    for (let i = 0; i < 100; i++) {
      const id = addRun({ agent: 'codex', job: 'file-question' })
      db().query(
        `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
         VALUES (?,'full','right',?,'claude')`,
      ).run(id, new Date(Date.now() + 1_000 + i).toISOString())
    }
    const byCount = orch('doctor')
    expect(byCount.code).toBe(0)
    expect(byCount.out).toContain('recalibrate: 100 scores since last blind check; run orch recalibrate --n 12')
  }, 20_000)
})
