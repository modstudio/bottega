import { expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        ORCH_IDLE_STALL_MS: '0',
        KEEPALIVE_TICKS: '100',
        NOTICE_TIMEOUT_SECONDS: '0',
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
    expect(output.match(/STALLED/g)).toHaveLength(1)
  } finally {
    sleeper.kill()
    await sleeper.exited
    rmSync(fakeBin, { recursive: true })
  }
})

test('heartbeat suppresses and acknowledges a stalled-run notice already reported directly', () => {
  const fixture = join(dir, 'heartbeat-notice-fixture')
  const hooks = join(fixture, 'orchestrator', 'hooks')
  const bin = join(fixture, 'bin')
  const ack = join(fixture, 'acknowledged')
  mkdirSync(hooks, { recursive: true })
  mkdirSync(bin)
  copyFileSync(
    fileURLToPath(new URL('../../hooks/orch-heartbeat.sh', import.meta.url)),
    join(hooks, 'orch-heartbeat.sh'),
  )
  const orch = join(bin, 'orch')
  writeFileSync(
    orch,
    `#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '[]'
elif [ "$1" = "runs" ]; then
  echo '{"id":42,"live_member_id":42,"job":"implement","agent":"codex","status":"running","session_id":"notice-session","started_at":"2026-09-22T12:00:00.000Z","latency_ms":null,"failure_kind":null,"idle":"idle 30m","stall_state":"stalled","stall":"run 42 codex/implement has stalled"}'
elif [ "$1" = "monitor" ] && [ "$2" = "--notices" ]; then
  echo '[{"noticeId":"condition:9","kind":"stalled-run","subject":"run:42","detail":"duplicate","ownerSession":"notice-session"}]'
elif [ "$1" = "monitor" ] && [ "$2" = "--ack-notices" ]; then
  printf '%s' "$3" > "$ACK_PATH"
else
  exit 2
fi
`,
  )
  chmodSync(orch, 0o755)

  const result = Bun.spawnSync(
    ['bash', join(hooks, 'orch-heartbeat.sh'), 'notice-session', '0', '1'],
    {
      cwd: fixture,
      env: {
        ...process.env,
        ACK_PATH: ack,
        ORCH_DB: join(fixture, 'absent.db'),
        KEEPALIVE_TICKS: '100',
        NOTICE_TIMEOUT_SECONDS: '5',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output.match(/STALLED/g)).toHaveLength(1)
  expect(output).not.toContain('MONITOR stalled-run')
  expect(readFileSync(ack, 'utf8')).toBe('condition:9')
  rmSync(fixture, { recursive: true })
})

test('heartbeat reports a stalled run without BLOCKED or WAITING', async () => {
  const session = 'heartbeat-stalled-only-fixture'
  const sleeper = Bun.spawn(['sleep', '30'])
  const run = addRun({
    agent: 'codex',
    job: 'review-lens',
    status: 'running',
    session,
    startedAt: '2026-09-22T12:00:00.000Z',
  })
  const birth = 'Tue Sep 22 12:00:00 2026'
  db()
    .query(
      'UPDATE run SET pid=?,agent_pid=?,agent_pgid=?,agent_start_time=?,last_event_at=? WHERE id=?',
    )
    .run(sleeper.pid, sleeper.pid, sleeper.pid, birth, '2026-09-22T12:00:00.000Z', run)

  const fakeBin = join(dir, 'heartbeat-stalled-only-bin')
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
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        ORCH_IDLE_STALL_MS: '0',
        KEEPALIVE_TICKS: '100',
        NOTICE_TIMEOUT_SECONDS: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain(`STALLED - 1 run(s): run ${run} codex/review-lens`)
    expect(output.match(/STALLED/g)).toHaveLength(1)
    expect(output).not.toContain('BLOCKED')
    expect(output).not.toContain('WAITING')
  } finally {
    sleeper.kill()
    await sleeper.exited
    rmSync(fakeBin, { recursive: true })
  }
})
