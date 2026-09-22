import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { dir } from '../../test/preload.ts'
import { db } from '../database/db.ts'

test('heartbeat reports both an answerable question and a stalled current turn', async () => {
  const session = 'heartbeat-mixed-fixture'
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking', session })
  const sleeper = Bun.spawn(['sleep', '30'])
  const turn = addRun({
    agent: 'grok',
    job: 'review-lens',
    status: 'running',
    parent: root,
    turn: 2,
    startedAt: '2026-09-22T12:00:00.000Z',
  })
  const birth = 'Tue Sep 22 12:00:00 2026'
  db()
    .query(
      'UPDATE run SET pid=?,agent_pid=?,agent_pgid=?,agent_start_time=?,last_event_at=? WHERE id=?',
    )
    .run(sleeper.pid, sleeper.pid, sleeper.pid, birth, '2026-09-22T12:00:00.000Z', turn)
  db()
    .query('INSERT INTO question (run_id,asked_at,question,why) VALUES (?,?,?,?)')
    .run(root, new Date().toISOString(), 'which way?', 'the fixture needs both conditions')

  const fakeBin = join(dir, 'heartbeat-bin')
  mkdirSync(fakeBin)
  const ps = join(fakeBin, 'ps')
  writeFileSync(
    ps,
    `#!/bin/sh
if [ "$1" = "-o" ]; then
  echo "${birth}"
else
  echo "${sleeper.pid} 1 ${sleeper.pid} 0.0 S"
fi
`,
  )
  chmodSync(ps, 0o755)

  try {
    const result = Bun.spawnSync(['bash', 'hooks/orch-heartbeat.sh', session, '0', '1'], {
      cwd: new URL('../../', import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        ORCH_IDLE_STALL_MS: '0',
        KEEPALIVE_TICKS: '100',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain('BLOCKED - 1 question(s) waiting on you')
    expect(output).toContain(`STALLED - 1 run(s): run ${turn} grok/review-lens`)
    expect(output).toContain('has used no CPU in that time; stop it and re-dispatch, or wait')
    expect(output).not.toContain(`run ${root} grok/review-lens`)
  } finally {
    sleeper.kill()
    await sleeper.exited
    rmSync(fakeBin, { recursive: true })
  }
})
