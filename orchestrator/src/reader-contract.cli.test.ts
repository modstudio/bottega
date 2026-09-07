import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AGENTS, JOBS, UNEVIDENCED_DELIVERABLE_ERROR, db, dir, hermeticGitEnv,
  jobTimeoutCeilingMinutes, listRunArtifacts, resolveJobTimeoutMs, runArtifactsDir,
  readDispatchState, runJob, upsertProject,
} from '../test/fixture.ts'

const CLI = new URL('cli.ts', import.meta.url).pathname

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

const repository = () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-reader-'))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'orch-test@example.invalid')
  git(repo, 'config', 'user.name', 'Orch Test')
  writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, 'commit', '-m', 'fixture')
  upsertProject({ name: `reader-${randomUUID()}`, path: repo, settings: { keyPrefixes: ['DEV'] } })
  return repo
}

const orch = (cwd: string, extraPath: string, ...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: {
      ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      PATH: `${extraPath}:${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const waitFor = (id: number, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const row = db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string } | null
    if (row && row.status !== 'running') return row.status
    Bun.sleepSync(20)
  }
  throw new Error(`run ${id} still running`)
}

const stubCodex = (body: string, receivesPrompt = false) => {
  const agent = AGENTS.codex!
  const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut, stdin: agent.stdin }
  const script = join(dir, `reader-agent-${randomUUID()}.ts`)
  writeFileSync(script, body)
  agent.bin = process.execPath
  agent.argv = receivesPrompt ? ({ prompt }) => [script, prompt] : () => [script]
  agent.readsOut = false
  agent.stdin = false
  process.env.ORCH_DEPTH = '0'
  return () => {
    agent.bin = original.bin
    agent.argv = original.argv
    agent.readsOut = original.readsOut
    agent.stdin = original.stdin
    rmSync(script, { force: true })
  }
}

const readerReply = (
  deliverables: { name: string; status: string; content: string }[],
  filesWritten: string[] | null = null,
) => JSON.stringify({ deliverables, narrative: 'notes', files_written: filesWritten })

describe('reader return contracts', () => {
  test('the reader receives and echoes its ordered declared deliverables', async () => {
    const repo = repository()
    const restore = stubCodex(`
const prompt = process.argv[2] ?? ''
const marker = 'DECLARED DELIVERABLES (ordered JSON): '
const line = prompt.split('\\n').find((part) => part.startsWith(marker))
const names = line ? JSON.parse(line.slice(marker.length)) : []
process.stdout.write(JSON.stringify({
  deliverables: names.map((name) => ({ name, status: 'delivered', content: 'echoed' })),
  narrative: null,
  files_written: null,
}))
`, true)
    try {
      const result = await runJob({
        job: 'diagnose', prompt: 'measure', cwd: repo, agent: 'codex',
        deliverables: ['per-file timing table', 'failing test name'], noFailover: true,
      })
      expect(result.status).toBe('ok')
      expect(result.output).toContain('per-file timing table')
      expect(result.output).toContain('failing test name')
    } finally {
      restore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a diagnose reply missing a deliverable is unevidenced', async () => {
    const repo = repository()
    const restore = stubCodex(`process.stdout.write(${JSON.stringify(readerReply([]))})\n`)
    try {
      let runId: number | undefined
      try {
        await runJob({
          job: 'diagnose', prompt: 'measure', cwd: repo, agent: 'codex',
          deliverables: ['x'], noFailover: true,
        })
      } catch (cause) {
        runId = (cause as Error & { runId?: number }).runId
      }
      expect(runId).toBeNumber()
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId!))
        .toEqual({
          status: 'failed', failure_kind: 'unevidenced',
          error: expect.stringContaining(`${UNEVIDENCED_DELIVERABLE_ERROR}: x`),
        })
    } finally {
      restore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a blocked deliverable with a reason is accepted', async () => {
    const repo = repository()
    const restore = stubCodex(`process.stdout.write(${JSON.stringify(readerReply([
      { name: 'x', status: 'blocked', content: 'docker.sock denied' },
    ]))})\n`)
    try {
      const result = await runJob({
        job: 'diagnose', prompt: 'measure', cwd: repo, agent: 'codex',
        deliverables: ['x'], noFailover: true,
      })
      expect(result.status).toBe('ok')
      expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(result.id))
        .toEqual({ failure_kind: null })
    } finally {
      restore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('artifacts are copied and listed', async () => {
    const repo = repository()
    const restore = stubCodex(`
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
writeFileSync(join(process.env.ORCH_SCRATCH!, 'timing-table.txt'), 'file,ms\\na,1\\n')
writeFileSync('named-evidence.txt', 'failing test: example\\n')
writeFileSync('tracked.txt', 'fixture changed during diagnosis\\n')
process.stdout.write(${JSON.stringify(readerReply([
      { name: 'x', status: 'delivered', content: 'see timing-table.txt' },
    ], ['named-evidence.txt']))})
`)
    try {
      const result = await runJob({
        job: 'diagnose', prompt: 'measure', cwd: repo, agent: 'codex',
        deliverables: ['x'], noFailover: true,
      })
      expect(result.status).toBe('ok')
      const artifacts = listRunArtifacts(result.id)
      expect(artifacts.some((p) => p.endsWith('timing-table.txt'))).toBe(true)
      expect(readFileSync(artifacts.find((p) => p.endsWith('timing-table.txt'))!, 'utf8'))
        .toContain('file,ms')
      expect(readFileSync(artifacts.find((p) => p.endsWith('named-evidence.txt'))!, 'utf8'))
        .toContain('failing test')
      expect(readFileSync(artifacts.find((p) => p.endsWith('worktree.diff'))!, 'utf8'))
        .toContain('fixture changed during diagnosis')
      const listed = Bun.spawnSync(
        [process.execPath, CLI, 'result', String(result.id), '--artifacts'],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(listed.stdout.toString()).toContain('timing-table.txt')
    } finally {
      restore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a reclaimed lens tree leaves its artifacts', async () => {
    const repo = repository()
    const restore = stubCodex(`
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
writeFileSync(join(process.env.ORCH_SCRATCH!, 'lens-note.txt'), 'covered\\n')
process.stdout.write(${JSON.stringify(JSON.stringify({
      findings: [],
      provenance: {
        standards_read: ['orchestrator/AGENTS.md'],
        model_used: 'test',
        files_covered: ['tracked.txt'],
        commands_run: ['git diff'],
        could_not_verify: [],
        canon_source: 'unknown',
      },
    }))})
`)
    try {
      let runId: number | undefined
      try {
        const result = await runJob({
          job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
          lens: 'reader-contract', noFailover: true,
        })
        runId = result.id
      } catch (cause) {
        runId = (cause as Error & { runId?: number }).runId
      }
      expect(runId).toBeNumber()
      const row = db().query('SELECT worktree FROM run WHERE id=?').get(runId!) as
        { worktree: string | null }
      expect(row.worktree).toBeNull()
      expect(existsSync(runArtifactsDir(runId!))).toBe(true)
      expect(listRunArtifacts(runId!).some((p) => p.endsWith('lens-note.txt'))).toBe(true)
    } finally {
      restore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an artifact copy failure records a harness failure and preserves the tree', async () => {
    const repo = repository()
    const restore = stubCodex(`process.stdout.write(${JSON.stringify(readerReply([
      { name: 'x', status: 'delivered', content: 'named evidence' },
    ], ['missing-evidence.txt']))})\n`)
    try {
      let runId: number | undefined
      try {
        await runJob({
          job: 'diagnose', prompt: 'measure', cwd: repo, agent: 'codex',
          deliverables: ['x'], noFailover: true,
        })
      } catch (cause) {
        runId = (cause as Error & { runId?: number }).runId
      }
      expect(runId).toBeNumber()
      const row = db().query(
        'SELECT status, failure_kind, error, worktree FROM run WHERE id=?',
      ).get(runId!) as {
        status: string; failure_kind: string; error: string; worktree: string | null
      }
      expect(row).toMatchObject({ status: 'failed', failure_kind: 'harness' })
      expect(row.error).toContain(runArtifactsDir(runId!))
      expect(row.error).toContain('missing-evidence.txt')
      expect(row.worktree).not.toBeNull()
      expect(existsSync(row.worktree!)).toBe(true)

      const shown = Bun.spawnSync([process.execPath, CLI, 'result', String(runId)], {
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(shown.exitCode).toBe(1)
      expect(shown.stderr.toString()).toContain(runArtifactsDir(runId!))
    } finally {
      restore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an artifact persistence failure cannot overwrite a concurrent operator stop', async () => {
    const repo = repository()
    const ready = join(dir, `reader-persist-stop-${randomUUID()}.ready`)
    const restore = stubCodex(`
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
mkdirSync(join(process.env.ORCH_SCRATCH, 'evidence.txt'))
writeFileSync('evidence.txt', 'named evidence\\n')
process.stdout.write(${JSON.stringify(readerReply([
      { name: 'x', status: 'delivered', content: 'named evidence' },
    ], ['evidence.txt']))})
writeFileSync(${JSON.stringify(ready)}, 'ready\\n')
await new Promise(() => {})
`)
    try {
      const pending = runJob({
        job: 'diagnose', prompt: 'measure', cwd: repo, agent: 'codex',
        deliverables: ['x'], noFailover: true,
      })
      for (let i = 0; i < 500 && !existsSync(ready); i++) await Bun.sleep(10)
      expect(existsSync(ready)).toBe(true)
      const running = db().query(
        `SELECT id FROM run WHERE status='running' ORDER BY id DESC LIMIT 1`,
      ).get() as { id: number }
      const stopped = orch(repo, dir, 'stop', String(running.id))
      expect(stopped.code, stopped.err).toBe(0)
      try { await pending } catch { /* the stopped vendor did not complete */ }
      expect(db().query('SELECT status, error, failure_kind FROM run WHERE id=?').get(running.id))
        .toEqual({ status: 'stopped', error: 'stopped by architect', failure_kind: null })
    } finally {
      restore()
      rmSync(ready, { force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('the timeout override respects the ceiling', () => {
    const fileQuestion = JOBS['file-question']!
    expect(jobTimeoutCeilingMinutes(fileQuestion)).toBe(20)
    expect(() => resolveJobTimeoutMs(fileQuestion, 25 * 60_000, 21))
      .toThrow(/file-question timeout ceiling is 20 minutes/)
    expect(resolveJobTimeoutMs(fileQuestion, 25 * 60_000, 20)).toBe(20 * 60_000)
    const diagnose = JOBS.diagnose!
    expect(() => resolveJobTimeoutMs(diagnose, 20 * 60_000, 60))
      .toThrow(/stale cutoff/)
    const r = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'x', '--timeout', '21', '--agent', 'codex'],
      {
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
        stdout: 'pipe', stderr: 'pipe',
      },
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain('file-question timeout ceiling is 20 minutes')
    const help = Bun.spawnSync([process.execPath, CLI, 'do', '--help'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(help.stdout.toString()).toContain('diagnose 40m/60m')
    expect(help.stdout.toString()).toContain('file-question agent/20m')
  })

  test('orch do diagnose --deliverable x returns unevidenced when x is missing', async () => {
    const repo = repository()
    const binDir = join(dir, `reader-cli-bin-${randomUUID()}`)
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\nprintf \'prose, no table\\n\'\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const launched = orch(
        repo, binDir,
        'do', 'diagnose', '--deliverable', 'x', 'measure the suite',
        '--agent', 'grok', '--no-failover', '--porcelain',
      )
      expect(launched.code).toBe(0)
      const id = Number(launched.out.trim())
      expect(id).toBeGreaterThan(0)
      waitFor(id)
      const row = db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(id) as
        { status: string; failure_kind: string | null; error: string | null }
      expect(row).toEqual({
        status: 'failed', failure_kind: 'unevidenced',
        error: expect.stringContaining(`${UNEVIDENCED_DELIVERABLE_ERROR}: x`),
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('orch retry preserves a reader root deliverable contract and timeout', async () => {
    const repo = repository()
    const binDir = join(dir, `reader-retry-bin-${randomUUID()}`)
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'grok'), [
      '#!/usr/bin/env bun',
      `const result = ${JSON.stringify(readerReply([]))}`,
      `process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n')`,
    ].join('\n'))
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const launched = orch(
        repo, binDir,
        'do', 'understand', '--deliverable', 'x', '--timeout', '17', 'measure',
        '--agent', 'grok', '--no-failover', '--porcelain',
      )
      expect(launched.code).toBe(0)
      const root = Number(launched.out.trim())
      expect(waitFor(root)).toBe('failed')

      const retried = orch(repo, binDir, 'retry', String(root), '--agent', 'grok', '--quiet')
      expect(retried.code).toBe(1)
      const child = db().query('SELECT id, failure_kind FROM run WHERE retry_of=?').get(root) as
        { id: number; failure_kind: string } | null
      expect(child, retried.err).not.toBeNull()
      if (!child) throw new Error(retried.err)
      expect(child.failure_kind).toBe('unevidenced')
      expect(readDispatchState(child.id)).toEqual({ deliverables: ['x'], timeoutMinutes: 17 })
      const promptPath = (db().query('SELECT prompt_path FROM run WHERE id=?').get(child.id) as
        { prompt_path: string }).prompt_path
      expect(readFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8'))
        .toContain('17 minutes')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 20_000)
})
