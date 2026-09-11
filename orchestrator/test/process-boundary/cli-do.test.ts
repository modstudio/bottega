import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { OrchRunEnvelopeSchema } from '../../../shared/orch-contract.ts'
import { runJson, AGENTS, JOBS, RUNS_DIR, addRun, bootstrapFixtureStore, callerDrift, db, declaredCreate, detachedRunOptions, dir, hermeticGitEnv, setDoc, upsertProject } from '../fixture.ts'
import { MAIN_CHECKOUT_INVARIANT, mainCheckoutWorktreeHint } from '../../src/projects.ts'

import { runCollectionDescribeFixture } from '../fixture.ts'

describe("detached run collection", () => {
  const { CLI, orchInput, orch, orchFrom, insert, dispatchArtifacts, expectNoDispatchArtifacts, conflictingImplement } = runCollectionDescribeFixture()
test('every --json surface has an enumerated and pinned output contract', () => {
    const monitorDb = join(dir, 'json-contract-orch.db')
    const hubDb = join(dir, 'json-contract-hub.db')
    const binDir = join(dir, 'json-contract-bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'docker'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'docker'), 0o755)
    const monitorEnv = {
      ORCH_DB: monitorDb, HUB_DB: hubDb, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }
    bootstrapFixtureStore(monitorDb)
    bootstrapFixtureStore(process.env.ORCH_DB!)
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

    const documents: {
      command: string; args: string[]; stdin?: string; env?: Record<string, string>; code?: number
    }[] = [
      { command: 'review calibration', args: ['review', 'calibration', 'safety', 'codex', 'model', '--json'] },
      { command: 'search', args: ['search', 'no-match', '--json'] },
      { command: 'blockers', args: ['blockers', '--json'] },
      { command: 'inbox', args: ['inbox', '--all', '--json'] },
      { command: 'project list', args: ['project', 'list', '--json'] },
      { command: 'project add', args: ['project', 'add', dir, '--name', 'json-added', '--no-canon', '--json'] },
      { command: 'project set', args: ['project', 'set', 'json-added', '--stack', 'node', '--json'] },
      { command: 'doc list', args: ['doc', 'list', '--json'] },
      { command: 'doc show', args: ['doc', 'show', 'json-show', '--scope', 'global', '--json'] },
      { command: 'doc set', args: ['doc', 'set', 'json-set', '--scope', 'global', '--title', 'Set', '--reason', 'json test', '--json'], stdin: 'body' },
      { command: 'doc consume', args: ['doc', 'consume', 'json-consume', '--scope', 'global', '--json'] },
      { command: 'doc rm', args: ['doc', 'rm', 'json-rm', '--scope', 'global', '--reason', 'json test', '--json'] },
      { command: 'doc subjects', args: ['doc', 'subjects', '--json'] },
      { command: 'workflow list', args: ['workflow', 'list', '--json'] },
      { command: 'workflow show', args: ['workflow', 'show', 'ship', '--json'] },
      { command: 'workflow versions', args: ['workflow', 'versions', 'ship', '--json'] },
      { command: 'workflow compose', args: ['workflow', 'compose', 'ship', '--arg', 'key=DEV-257', '--arg', 'branch=feature/DEV-257', '--arg', 'worktree=/tmp/tree', '--json'] },
      { command: 'workflow step', args: ['workflow', 'step', 'ship', 'lens', '--arg', 'key=DEV-257', '--arg', 'branch=feature/DEV-257', '--arg', 'worktree=/tmp/tree', '--json'] },
      { command: 'review coverage-audit', args: ['review', 'coverage-audit', '--json'] },
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
      { command: 'monitor history', args: ['monitor', '--history', '--json'], env: monitorEnv },
      { command: 'monitor', args: ['monitor', '--json'], code: 1,
        env: monitorEnv },
      { command: 'canon evals', args: ['canon', 'evals', '--json'] },
    ]

    expect(documents).toHaveLength(34)
    for (const surface of documents) {
      const result = orchInput(surface.args, surface.stdin, surface.env)
      expect(result.code, surface.command).toBe(surface.code ?? 0)
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
    for (const line of lines) {
      expect(OrchRunEnvelopeSchema.parse(JSON.parse(line))).toMatchObject({
        schema_version: 2, kind: 'run', data: { id: expect.any(Number) },
      })
    }

    const legacy = orch('runs', '--json=v1')
    expect(legacy.code).toBe(0)
    for (const line of legacy.out.trim().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ id: expect.any(Number) })
    }

    const help = orch('--help').out
    expect(help.match(/one JSON document/g)).toHaveLength(documents.length)
    expect(help.match(/one JSON object per line/g)).toHaveLength(1)
  }, 20_000)

  test('detach spawns exec.ts as its child entry point', async () => {
    const bin = join(dir, `entry-${randomUUID()}.sh`)
    const marker = join(dir, `entry-${randomUUID()}.txt`)
    writeFileSync(bin, '#!/bin/sh\nprintf "%s" "$1" > "$ORCH_ENTRY_MARKER"\n')
    chmodSync(bin, 0o755)
    const result = orchInput(['do', 'file-question', 'entry point', '--agent', 'codex'], undefined, {
      ORCH_EXEC_PATH: bin, ORCH_ENTRY_MARKER: marker,
    })
    expect(result.code, result.err).toBe(0)
    for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt++) await Bun.sleep(10)
    expect(readFileSync(marker, 'utf8')).toEndWith('/orchestrator/src/exec.ts')
  })

  test('three concurrent detached dispatches all claim rows in one store', async () => {
    const store = join(dir, `concurrent-detach-${randomUUID()}.db`)
    const runs = join(dir, `concurrent-detach-runs-${randomUUID()}`)
    const env = {
      ...process.env,
      ORCH_DB: store,
      ORCH_RUNS: runs,
      ORCH_DEPTH: '0',
      ORCH_EXEC_PATH: '/usr/bin/true',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session',
    }
    bootstrapFixtureStore(store)

    const children = [1, 2, 3].map((n) => Bun.spawn(
      [process.execPath, CLI, 'do', 'file-question', `concurrent ${n}`, '--agent', 'codex', '--detach'],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' },
    ))
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })))

    expect(results.map(({ code }) => code)).toEqual([0, 0, 0])
    expect(results.map(({ out }) => Number(out.trim())).every((id) => id > 0)).toBe(true)
    expect(results.map(({ err }) => err).join('\n')).not.toContain('database is locked')
    const scratch = new Database(store)
    try {
      expect(scratch.query("SELECT COUNT(*) n FROM run WHERE agent='(pending)'").get())
        .toEqual({ n: 3 })
    } finally {
      scratch.close()
    }
  })

  test('detach with a bad execPath marks the reserved row failed/harness', () => {
    upsertProject({ name: 'spawn-fail', path: process.cwd(), settings: { requireCleanMain: false } })
    const r = Bun.spawnSync([
      process.execPath, CLI, 'do', 'file-question', '--repo', 'spawn-fail', '--mcp=prefer', 'hello',
    ], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ORCH_EXEC_PATH: '/definitely/not-an-orch-exec-DEV-73',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    const row = db().query(
      'SELECT agent, status, failure_kind, error, pid, mcp FROM run ORDER BY id DESC LIMIT 1',
    ).get() as {
      agent: string; status: string; failure_kind: string; error: string
      pid: number | null; mcp: number
    }
    expect(row.agent).toBe('(pending)')
    expect(row.status).toBe('failed')
    expect(row.failure_kind).toBe('harness')
    expect(row.error).toContain('spawn failed')
    expect(row.error).toContain('/definitely/not-an-orch-exec-DEV-73')
    expect(row.pid).toBeNull()
    expect(row.mcp).toBe(2)
  })

})
