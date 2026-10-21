import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { startGateBroker } from './gate-broker.ts'

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

test('an occupied gate log path fails the execution without following the path', async () => {
  const root = mkdtempSync(join(dir, 'gate-broker-occupied-log-'))
  const scratch = join(root, 'scratch')
  const sentinel = join(root, 'sentinel.txt')
  mkdirSync(scratch)
  writeFileSync(sentinel, 'original')

  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id`,
      )
      .get(
        newRecordId(),
        'gate-broker-occupied-log-fixture',
        root,
        'bun',
        JSON.stringify({ gate: 'scripts/gate', trunk: 'main' }),
      ) as { id: string }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,1,'fixture','running',?,?,?,'git') RETURNING record_id AS id`,
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
      ) as { id: string }
  ).id
  const gateId = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id, run_record_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
      )
      .get(runId, new Date().toISOString()) as { id: number }
  ).id
  const occupiedPath = join(scratch, `gate-${gateId}.log`)
  symlinkSync(sentinel, occupiedPath)

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: '/main/checkout' },
    withHostSlot: async (run) => run(),
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
