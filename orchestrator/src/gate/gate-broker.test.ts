import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

test("a rebased worker records only the worker's gate tooling changes", async () => {
  const root = mkdtempSync(join(dir, 'gate-broker-'))
  const repository = join(root, 'repository')
  const scratch = join(root, 'scratch')
  mkdirSync(repository)
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.name', 'Fixture')
  git(repository, 'config', 'user.email', 'fixture@example.test')

  writeFileSync(join(repository, 'README.md'), 'base\n')
  git(repository, 'add', 'README.md')
  git(repository, 'commit', '-m', 'base')
  const recordedBase = git(repository, 'rev-parse', 'HEAD')

  mkdirSync(join(repository, 'scripts'))
  writeFileSync(join(repository, 'scripts', 'trunk.ts'), 'export const trunk = true\n')
  git(repository, 'add', 'scripts/trunk.ts')
  git(repository, 'commit', '-m', 'trunk tooling')

  git(repository, 'switch', '-c', 'worker', recordedBase)
  mkdirSync(join(repository, 'scripts'))
  writeFileSync(join(repository, 'scripts', 'worker.ts'), 'export const worker = true\n')
  git(repository, 'add', 'scripts/worker.ts')
  git(repository, 'commit', '-m', 'worker tooling')
  git(repository, 'rebase', 'main')

  const projectId = (
    db()
      .query(`INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?) RETURNING id`)
      .get(
        'gate-broker-fixture',
        repository,
        'bun',
        JSON.stringify({ gate: 'true', trunk: 'main' }),
      ) as {
      id: number
    }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (started_at,agent,job,project_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit)
         VALUES (?,?,?,?,?,1,'fixture','running',?,?) RETURNING id`,
      )
      .get(
        new Date().toISOString(),
        'codex',
        'implement',
        projectId,
        'sha',
        repository,
        recordedBase,
      ) as {
      id: number
    }
  ).id
  const gateId = (
    db()
      .query('INSERT INTO gate_execution (run_id,requested_at) VALUES (?,?) RETURNING id')
      .get(runId, new Date().toISOString()) as { id: number }
  ).id

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: repository },
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
  } finally {
    await broker.close()
    rmSync(root, { recursive: true, force: true })
  }
})
