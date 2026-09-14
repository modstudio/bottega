import { expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../../src/db.ts'
import { projectByName, upsertProject } from '../../src/projects.ts'
import { repoRootOf } from '../../src/git-environment.ts'
import { RUNS_DIR } from '../../src/run-artifacts.ts'
import { dir, testSpawn, testSpawnSync } from '../preload.ts'

export async function runWithDelayedStdoutReader(
  argv: string[], env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const { closeSync, mkdtempSync, openSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const pipeDir = mkdtempSync(join(tmpdir(), 'orch-slow-stdout-'))
  const fifo = join(pipeDir, 'stdout.fifo')
  const made = testSpawnSync(['mkfifo', fifo], { stdout: 'pipe', stderr: 'pipe' })
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  try {
    const reader = testSpawn(
      ['sh', '-c', 'exec 3<"$1"; sleep 0.25; cat <&3', 'slow-reader', fifo],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const writer = openSync(fifo, 'w')
    const producer = testSpawn(argv, { env, stdout: writer, stderr: 'pipe' })
    closeSync(writer)
    const [exitCode, stdout, stderr, readerExit, readerError] = await Promise.all([
      producer.exited, new Response(reader.stdout).arrayBuffer(),
      new Response(producer.stderr).text(), reader.exited, new Response(reader.stderr).text(),
    ])
    if (readerExit !== 0) throw new Error(readerError || `slow reader exited ${readerExit}`)
    return { exitCode, stdout: Buffer.from(stdout), stderr }
  } finally { rmSync(pipeDir, { recursive: true, force: true }) }
}

export function runCollectionDescribeFixture() {
  const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
  const orchInput = (args: string[], stdin?: string | Uint8Array, extraEnv: Record<string, string> = {}) => {
    const result = testSpawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session', ...extraEnv },
      stdin: stdin === undefined ? undefined
        : typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin,
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: result.exitCode, out: new TextDecoder().decode(result.stdout),
      err: new TextDecoder().decode(result.stderr) }
  }
  const orch = (...args: string[]) => orchInput(args)
  const scoreReminder = (session: string) => testSpawnSync(
    ['python3', new URL('../../hooks/score-reminder.py', import.meta.url).pathname],
    { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: session })),
      stdout: 'pipe', stderr: 'pipe' },
  )
  const orchFrom = (cwd: string, session: string, ...args: string[]) => {
    const result = testSpawnSync([process.execPath, CLI, ...args], {
      cwd, env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: session }, stdout: 'pipe', stderr: 'pipe',
    })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const insert = (status: string, job = 'file-question') => (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
  ).get(new Date().toISOString(), job, status) as { id: number }).id
  const checkpointedOrch = async (checkpoint: string, ...args: string[]) => {
    const token = randomUUID()
    const ready = join(dir, `lifecycle-ready-${token}`)
    const release = join(dir, `lifecycle-release-${token}`)
    const child = testSpawn([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session', ORCH_TEST_LIFECYCLE_CHECKPOINT: checkpoint,
        ORCH_TEST_LIFECYCLE_READY: ready, ORCH_TEST_LIFECYCLE_RELEASE: release },
      stdout: 'pipe', stderr: 'pipe',
    })
    const deadline = Date.now() + 5_000
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5)
    expect(existsSync(ready)).toBe(true)
    return { child, release }
  }
  const lifecycleResult = async (child: ReturnType<typeof Bun.spawn>) => {
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ])
    return { code, out, err }
  }
  const dispatchArtifacts = (cwd: string) => {
    const root = repoRootOf(cwd) ?? cwd
    const trees = join(root, '.claude', 'worktrees')
    return { runs: (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n,
      prompts: existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).sort() : [],
      lock: existsSync(join(root, '.git', 'orch-create.lock')),
      worktrees: existsSync(trees) ? readdirSync(trees).sort() : null }
  }
  const expectNoDispatchArtifacts = (cwd: string, before: ReturnType<typeof dispatchArtifacts>) =>
    expect(dispatchArtifacts(cwd)).toEqual(before)
  const conflictingImplement = (extra: string[]) => {
    const binDir = join(dir, `conflict-warn-bin-${extra.join('-') || 'human'}`)
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    return testSpawnSync([process.execPath, CLI, 'do', 'implement',
      'Make the change.\nThen push the branch.', '--agent', 'codex', ...extra],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env,
      PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session', FORCE_COLOR: '1' } })
  }
  const expectCreateMigrationRefused = (
    name: string, create: string, token: string, position: number, kind = 'unsupported shell token',
  ) => {
    upsertProject({ name, path: process.cwd(), settings: { worktree: { create } } as any })
    const result = orch('project', 'migrate-create', name, '--apply')
    expect(result.code).toBe(0)
    expect(result.out).toContain(`${kind} ${JSON.stringify(token)} at position ${position}; cannot migrate`)
    expect(projectByName(name)!.settings.worktree?.create as any).toBe(create)
  }
  return { CLI, orchInput, orch, scoreReminder, orchFrom, insert, checkpointedOrch,
    lifecycleResult, dispatchArtifacts, expectNoDispatchArtifacts, conflictingImplement,
    expectCreateMigrationRefused }
}
