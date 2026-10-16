import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { startGateBroker } from './gate-broker.ts'

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString().trim()
}

async function waitForFinishedGate(id: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = db().query('SELECT finished_at FROM gate_execution WHERE id=?').get(id) as {
      finished_at: string | null
    }
    if (row.finished_at) return
    await Bun.sleep(10)
  }
  throw new Error(`gate execution ${id} did not finish`)
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${description}`)
}

test("a rebased writer runs the gate from its tree and records only a clean tree's HEAD", async () => {
  const root = mkdtempSync(join(dir, 'gate-broker-'))
  const repository = join(root, 'repository')
  const scratch = join(root, 'scratch')
  mkdirSync(repository)
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.name', 'Fixture')
  git(repository, 'config', 'user.email', 'fixture@example.test')

  mkdirSync(join(repository, 'scripts'))
  writeFileSync(join(repository, 'scripts', 'gate'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(repository, 'scripts', 'gate'), 0o755)
  writeFileSync(join(repository, 'README.md'), 'base\n')
  git(repository, 'add', 'README.md', 'scripts/gate')
  git(repository, 'commit', '-m', 'base')
  const recordedBase = git(repository, 'rev-parse', 'HEAD')

  writeFileSync(join(repository, 'scripts', 'trunk.ts'), 'export const trunk = true\n')
  git(repository, 'add', 'scripts/trunk.ts')
  git(repository, 'commit', '-m', 'trunk tooling')

  git(repository, 'switch', '-c', 'worker', recordedBase)
  writeFileSync(join(repository, 'scripts', 'worker.ts'), 'export const worker = true\n')
  git(repository, 'add', 'scripts/worker.ts')
  git(repository, 'commit', '-m', 'worker tooling')
  git(repository, 'rebase', 'main')

  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?) RETURNING id`,
      )
      .get(
        'gate-broker-fixture',
        repository,
        'bun',
        JSON.stringify({ gate: 'scripts/gate', trunk: 'main' }),
      ) as {
      id: number
    }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (record_id,started_at,agent,job,project_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES ('${newRecordId()}',?,?,?,?,?,1,'fixture','running',?,?,?,'git') RETURNING id`,
      )
      .get(
        new Date().toISOString(),
        'codex',
        'implement',
        projectId,
        'sha',
        repository,
        recordedBase,
        git(repository, 'rev-parse', 'HEAD'),
      ) as {
      id: number
    }
  ).id
  const gateId = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id, run_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
      )
      .get(runId, new Date().toISOString()) as { id: number }
  ).id
  const started: number[] = []
  const finished: number[] = []

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: '/main/checkout' },
    onExecutionStart: ({ executionId }) => started.push(executionId),
    onExecutionFinish: ({ executionId }) => finished.push(executionId),
  })
  try {
    await waitForFinishedGate(gateId)
    expect(
      (
        db().query('SELECT tooling_paths FROM gate_execution WHERE id=?').get(gateId) as {
          tooling_paths: string
        }
      ).tooling_paths,
    ).toBe('["scripts/worker.ts"]')
    expect(
      (
        db().query('SELECT resolved_command FROM gate_execution WHERE id=?').get(gateId) as {
          resolved_command: string
        }
      ).resolved_command,
    ).toBe(`'${join(repository, 'scripts', 'gate')}'`)
    expect(
      (
        db().query('SELECT head_commit FROM gate_execution WHERE id=?').get(gateId) as {
          head_commit: string | null
        }
      ).head_commit,
    ).toBe(git(repository, 'rev-parse', 'HEAD'))

    writeFileSync(join(repository, 'README.md'), 'dirty\n')
    const dirtyGateId = (
      db()
        .query(
          `INSERT INTO gate_execution (record_id, run_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
        )
        .get(runId, new Date().toISOString()) as { id: number }
    ).id
    await waitForFinishedGate(dirtyGateId)
    expect(
      (
        db().query('SELECT head_commit FROM gate_execution WHERE id=?').get(dirtyGateId) as {
          head_commit: string | null
        }
      ).head_commit,
    ).toBeNull()

    writeFileSync(join(repository, 'scripts', 'gate'), '#!/bin/sh\nwhile :; do sleep 1; done\n')
    const cancelledGateId = (
      db()
        .query(
          `INSERT INTO gate_execution (record_id, run_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
        )
        .get(runId, new Date().toISOString()) as { id: number }
    ).id
    await waitFor(() => started.includes(cancelledGateId), `gate ${cancelledGateId} to start`)
    await broker.close()

    expect(started).toEqual([gateId, dirtyGateId, cancelledGateId])
    expect(finished).toEqual([gateId, dirtyGateId, cancelledGateId])
    expect(
      (
        db()
          .query('SELECT cancelled_reason FROM gate_execution WHERE id=?')
          .get(cancelledGateId) as {
          cancelled_reason: string | null
        }
      ).cancelled_reason,
    ).not.toBeNull()
  } finally {
    await broker.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an occupied gate log path fails the execution without following the path', async () => {
  const root = mkdtempSync(join(dir, 'gate-broker-occupied-log-'))
  const scratch = join(root, 'scratch')
  const sentinel = join(root, 'sentinel.txt')
  mkdirSync(scratch)
  writeFileSync(sentinel, 'original')

  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
        'gate-broker-occupied-log-fixture',
        root,
        'bun',
        JSON.stringify({ gate: 'scripts/gate', trunk: 'main' }),
      ) as { id: number }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (record_id,started_at,agent,job,project_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES ('${newRecordId()}',?,?,?,?,?,1,'fixture','running',?,?,?,'git') RETURNING id`,
      )
      .get(
        new Date().toISOString(),
        'codex',
        'implement',
        projectId,
        'sha',
        root,
        'base',
        'head',
      ) as { id: number }
  ).id
  const gateId = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id, run_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
      )
      .get(runId, new Date().toISOString()) as { id: number }
  ).id
  const occupiedPath = join(scratch, `gate-${gateId}.log`)
  symlinkSync(sentinel, occupiedPath)

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: '/main/checkout' },
  })
  try {
    await waitForFinishedGate(gateId)
    const execution = db()
      .query('SELECT exit_code,output_tail,output_artifact FROM gate_execution WHERE id=?')
      .get(gateId) as { exit_code: number; output_tail: string; output_artifact: string | null }

    expect(execution.exit_code).toBe(-1)
    expect(execution.output_artifact).toBeNull()
    expect(execution.output_tail).toContain(
      `gate log path is occupied: ${occupiedPath}; gate did not run`,
    )
    expect(readFileSync(sentinel, 'utf8')).toBe('original')
  } finally {
    await broker.close()
    rmSync(root, { recursive: true, force: true })
  }
})

