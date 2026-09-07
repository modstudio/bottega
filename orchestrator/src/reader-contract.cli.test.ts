import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AGENTS, JOBS, UNEVIDENCED_DELIVERABLE_ERROR, db, dir, hermeticGitEnv,
  jobTimeoutCeilingMinutes, listRunArtifacts, resolveJobTimeoutMs, runArtifactsDir,
  runJob, upsertProject,
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

const stubCodex = (body: string) => {
  const agent = AGENTS.codex!
  const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut, stdin: agent.stdin }
  const script = join(dir, `reader-agent-${randomUUID()}.ts`)
  writeFileSync(script, body)
  agent.bin = process.execPath
  agent.argv = () => [script]
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
})
