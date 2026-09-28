import { expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  echo '[{"noticeId":"condition:9","kind":"stalled-run","subject":"run:42","detail":"duplicate","ownerSession":"notice-session"},{"noticeId":"condition:10","kind":"resource-pressure","subject":"machine","detail":"visible","ownerSession":"notice-session"}]'
elif [ "$1" = "monitor" ] && [ "$2" = "--ack-notices" ]; then
  printf '%s' "$3" > "$ACK_PATH"
else
  exit 2
fi
`,
  )
  chmodSync(orch, 0o755)

  const startedAt = performance.now()
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
  expect(performance.now() - startedAt).toBeLessThan(2_000)
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output.match(/STALLED/g)).toHaveLength(1)
  expect(output).not.toContain('MONITOR stalled-run')
  expect(output).toContain('MONITOR resource-pressure machine: visible')
  expect(output.split('\n').slice(0, -1)).not.toContain('')
  expect(readFileSync(ack, 'utf8')).toBe('condition:9,condition:10')
  rmSync(fixture, { recursive: true })
})

test('heartbeat emits nothing extra when its only notice is a suppressed duplicate', () => {
  const fixture = join(dir, 'heartbeat-only-suppressed-notice-fixture')
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
  expect(output).not.toContain('DEGRADED')
  expect(output.split('\n').slice(0, -1)).not.toContain('')
  expect(readFileSync(ack, 'utf8')).toBe('condition:9')
  rmSync(fixture, { recursive: true })
})

test('heartbeat termination reaps an active guarded call and its watchdog', async () => {
  const fixture = join(dir, 'heartbeat-termination-fixture')
  const hooks = join(fixture, 'orchestrator', 'hooks')
  const bin = join(fixture, 'bin')
  const targetPidPath = join(fixture, 'target.pid')
  const watchdogPidPath = join(fixture, 'watchdog.pid')
  const watchdogSleepPidPath = join(fixture, 'watchdog-sleep.pid')
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
  echo '{"id":42,"live_member_id":42,"job":"implement","agent":"codex","status":"running","session_id":"termination-session","started_at":"2026-09-22T12:00:00.000Z","latency_ms":null,"failure_kind":null,"idle":null,"stall_state":"healthy","stall":null}'
elif [ "$1" = "monitor" ] && [ "$2" = "--notices" ]; then
  echo "$$" > "$TARGET_PID_PATH"
  exec /bin/sleep 30
else
  exit 2
fi
`,
  )
  chmodSync(orch, 0o755)
  const sleep = join(bin, 'sleep')
  writeFileSync(
    sleep,
    `#!/bin/sh
echo "$PPID" > "$WATCHDOG_PID_PATH"
echo "$$" > "$WATCHDOG_SLEEP_PID_PATH"
exec /bin/sleep "$@"
`,
  )
  chmodSync(sleep, 0o755)

  const heartbeat = Bun.spawn(
    ['bash', join(hooks, 'orch-heartbeat.sh'), 'termination-session', '0', '1'],
    {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ORCH_DB: join(fixture, 'absent.db'),
        KEEPALIVE_TICKS: '100',
        NOTICE_TIMEOUT_SECONDS: '30',
        TARGET_PID_PATH: targetPidPath,
        WATCHDOG_PID_PATH: watchdogPidPath,
        WATCHDOG_SLEEP_PID_PATH: watchdogSleepPidPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  try {
    const recordedDeadline = performance.now() + 2_000
    while (
      ![targetPidPath, watchdogPidPath, watchdogSleepPidPath].every(existsSync) &&
      performance.now() < recordedDeadline
    ) {
      await Bun.sleep(10)
    }
    expect([targetPidPath, watchdogPidPath, watchdogSleepPidPath].every(existsSync)).toBe(true)
    const pids = [targetPidPath, watchdogPidPath, watchdogSleepPidPath].map((path) =>
      Number(readFileSync(path, 'utf8')),
    )

    heartbeat.kill('SIGTERM')
    await heartbeat.exited

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const reapedDeadline = performance.now() + 2_000
    while (pids.some(isAlive) && performance.now() < reapedDeadline) {
      await Bun.sleep(10)
    }
    expect(pids.map(isAlive)).toEqual([false, false, false])
  } finally {
    heartbeat.kill('SIGTERM')
    await heartbeat.exited
    rmSync(fixture, { recursive: true })
  }
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
