import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, canonSourceInstruction, db, dir, hermeticGitEnv, reviewReply, runJob, upsertProject } from '../fixture.ts'
import { stubWorker } from "../stub-worker.ts"

const GROK_REVIEW_EVENT = JSON.stringify({
  type: 'result', subtype: 'success', result: JSON.stringify(reviewReply(1)),
})
const GROK_DOCTOR_OUTPUT = JSON.stringify({
  servers: [{
    name: 'fixture-project', healthy: false,
    checks: [{ label: 'unavailable', passed: false, detail: 'server down' }],
  }],
})

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); rmSync(join(dir, '.mcp.json'), { force: true }) })
const fakeGrok = () => {
  const binDir = mkdtempSync(join(tmpdir(), 'orch-mcp-boundary-')); roots.push(binDir)
  symlinkSync(stubWorker({ exitCode: 99 }), join(binDir, 'grok'))
  return binDir
}
const invoke = (args: string[], binDir: string) => Bun.spawnSync(
  [process.execPath, new URL('../../src/cli.ts', import.meta.url).pathname, ...args],
  { cwd: realpathSync(dir), env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
    CLAUDE_CODE_SESSION_ID: 'orch-test-session', PATH: `${binDir}:${process.env.PATH ?? ''}`,
    ORCH_STUB_MCP_DOCTOR_OUTPUT: GROK_DOCTOR_OUTPUT,
    ORCH_STUB_OUTPUT: GROK_REVIEW_EVENT },
    stdout: 'pipe', stderr: 'pipe' },
)
async function terminalRows(afterId: number, count: number) {
  const deadline = Date.now() + 5_000
  let rows: { status: string; error: string | null }[] = []
  while (Date.now() < deadline) {
    rows = db().query('SELECT status,error FROM run WHERE id>? ORDER BY id').all(afterId) as typeof rows
    if (rows.length === count && rows.every((row) => row.status !== 'running')) break
    await Bun.sleep(20)
  }
  return rows
}

test('orch do defers a no-repo Grok MCP doctor to its isolate', () => {
  const cwd = realpathSync(dir); upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
  const result = invoke(['do', 'mcp-query', 'query the server', '--mcp', '--agent', 'grok'], fakeGrok())
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const id = Number(result.stdout.toString().trim()); expect(id).toBeGreaterThan(0)
  expect(db().query('SELECT job FROM run WHERE id=?').get(id)).toEqual({ job: 'mcp-query' })
})

test('detached orch do records a cwd-preflight refusal before grok starts', async () => {
  const cwd = realpathSync(dir); upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
  writeFileSync(join(cwd, '.mcp.json'), '{}\n')
  const before = (db().query('SELECT MAX(id) id FROM run').get() as { id: number | null }).id ?? 0
  const result = invoke(['do', 'review-lens', 'review this', '--mcp', '--agent', 'grok', '--lens', 'probe'], fakeGrok())
  expect(result.exitCode).toBe(0)
  const rows = await terminalRows(before, 1)
  expect(rows).toEqual([{ status: 'failed', error: expect.stringContaining("server 'fixture-project' could not be attached") }])
  expect(rows[0]!.error).toContain('unavailable: server down')
})

test('a fan-out of grok --mcp records one pre-spawn refusal per worker tree', async () => {
  const cwd = realpathSync(dir); upsertProject({ name: 'fixture-project', path: cwd, settings: {} })
  writeFileSync(join(cwd, '.mcp.json'), '{}\n')
  const before = (db().query('SELECT MAX(id) id FROM run').get() as { id: number | null }).id ?? 0
  const binDir = fakeGrok()
  for (const n of [1, 2, 3]) expect(invoke(['do', 'review-lens', `lens ${n}`, '--mcp', '--agent', 'grok', '--lens', 'probe'], binDir).exitCode).toBe(0)
  const rows = await terminalRows(before, 3)
  expect(rows).toHaveLength(3)
  expect(rows.every((row) => row.status === 'failed' && row.error?.includes("server 'fixture-project' could not be attached"))).toBe(true)
})

test('continue without parent output inherits prefer, re-probes, and keeps MIRROR explicit', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-mcp-cwd-'))); roots.push(repo)
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  expect(git('init', '-b', 'main').exitCode).toBe(0)
  git('config', 'user.email', 'orch-test@example.invalid'); git('config', 'user.name', 'Orch Test')
  writeFileSync(join(repo, 'tracked.txt'), 'base\n'); git('add', 'tracked.txt'); git('commit', '-m', 'base')
  writeFileSync(join(repo, '.mcp.json'), '{}\n'); upsertProject({ name: 'fixture-project', path: repo, settings: {} })
  const binDir = mkdtempSync(join(tmpdir(), 'orch-grok-prefer-continue-')); roots.push(binDir)
  const script = stubWorker()
  symlinkSync(script, join(binDir, 'grok'))
  const agent = AGENTS.grok!; const original = { bin: agent.bin, argv: agent.argv }
  const priorDepth = process.env.ORCH_DEPTH; const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorDoctor = process.env.ORCH_STUB_MCP_DOCTOR_OUTPUT; const priorOutput = process.env.ORCH_STUB_OUTPUT
  agent.bin = script; agent.argv = () => []; process.env.ORCH_DEPTH = '0'; process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  process.env.ORCH_STUB_MCP_DOCTOR_OUTPUT = GROK_DOCTOR_OUTPUT; process.env.ORCH_STUB_OUTPUT = GROK_REVIEW_EVENT
  try {
    const root = await runJob({ job: 'review-lens', prompt: 'review this', cwd: repo, agent: 'grok', mcp: 'prefer', lens: 'mcp-cwd', keepTree: true })
    expect((db().query('SELECT mcp FROM run WHERE id=?').get(root.id) as { mcp: number }).mcp).toBe(2)
    db().query('DELETE FROM review WHERE id=(SELECT review_id FROM review_lens WHERE run_id=?)').run(root.id)
    unlinkSync(root.outPath); expect(existsSync(root.outPath)).toBe(false)
    agent.bin = original.bin; agent.argv = original.argv
    const child = invoke(['continue', String(root.id), 'review once more'], binDir)
    expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0)
    const childId = Number(child.stdout.toString().replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0]); expect(childId).toBeGreaterThan(0)
    const waited = invoke(['wait', String(childId), '--timeout', '15'], binDir)
    expect(waited.exitCode, `${waited.stdout.toString()}\n${waited.stderr.toString()}`).toBe(0)
    expect(db().query('SELECT parent_run_id,mcp,mcp_connected,mcp_error,input_tree FROM run WHERE id=?').get(childId)).toEqual({
      parent_run_id: root.id, mcp: 2, mcp_connected: 0, mcp_error: 'mirror: unavailable: server down', input_tree: expect.any(String),
    })
    const row = db().query('SELECT input_tree,prompt_path FROM run WHERE id=?').get(childId) as { input_tree: string; prompt_path: string }
    const childTree = git('-C', root.worktree!.path, 'ls-tree', '-r', '--name-only', row.input_tree).stdout.toString().trim().split('\n')
    expect(childTree).not.toContain('.mcp.json')
    const collected = invoke(['result', String(childId)], binDir); expect(collected.stderr.toString()).toContain('MIRROR — not the live database')
    expect(readFileSync(row.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')).toContain(canonSourceInstruction('mirror'))
  } finally {
    agent.bin = original.bin; agent.argv = original.argv
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorDoctor === undefined) delete process.env.ORCH_STUB_MCP_DOCTOR_OUTPUT; else process.env.ORCH_STUB_MCP_DOCTOR_OUTPUT = priorDoctor
    if (priorOutput === undefined) delete process.env.ORCH_STUB_OUTPUT; else process.env.ORCH_STUB_OUTPUT = priorOutput
  }
}, 20_000)
