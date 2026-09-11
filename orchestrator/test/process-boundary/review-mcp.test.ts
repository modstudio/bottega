import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, dir, upsertProject } from '../fixture.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); rmSync(join(dir, '.mcp.json'), { force: true }) })
const fakeGrok = () => {
  const binDir = mkdtempSync(join(tmpdir(), 'orch-mcp-boundary-')); roots.push(binDir)
  writeFileSync(join(binDir, 'grok'), `#!/bin/sh
if case " $* " in *" mcp doctor "*) true ;; *) false ;; esac; then
  printf '%s' '{"servers":[{"name":"fixture-project","healthy":false,"checks":[{"label":"unavailable","passed":false,"detail":"server down"}]}]}'
  exit 0
fi
echo should-not-launch >&2
exit 99
`)
  chmodSync(join(binDir, 'grok'), 0o755)
  return binDir
}
const invoke = (args: string[], binDir: string) => Bun.spawnSync(
  [process.execPath, new URL('../../src/cli.ts', import.meta.url).pathname, ...args],
  { cwd: realpathSync(dir), env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
    CLAUDE_CODE_SESSION_ID: 'orch-test-session', PATH: `${binDir}:${process.env.PATH ?? ''}` },
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
