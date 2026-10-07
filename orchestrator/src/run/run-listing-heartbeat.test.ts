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

test('heartbeat announces an unchanged notice query failure once with its reason', () => {
  const fixture = join(dir, 'heartbeat-notice-failure-fixture')
  const hooks = join(fixture, 'orchestrator', 'hooks')
  const bin = join(fixture, 'bin')
  const counterPath = join(fixture, 'monitor-count')
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
if [ "$1" = "board" ]; then
  exit 0
elif [ "$1" = "inbox" ]; then
  echo '[]'
elif [ "$1" = "runs" ]; then
  echo '{"id":42,"live_member_id":42,"job":"implement","agent":"codex","status":"running","session_id":"notice-failure-session","started_at":"2026-09-22T12:00:00.000Z","latency_ms":null,"failure_kind":null,"idle":null,"stall_state":"healthy","stall":null}'
elif [ "$1" = "monitor" ] && [ "$2" = "--notices" ]; then
  count=0
  [ ! -f "$COUNTER_PATH" ] || count=$(<"$COUNTER_PATH")
  count=$((count + 1))
  echo "$count" > "$COUNTER_PATH"
  if [ "$SCENARIO" = "recovery" ] && [ "$count" -eq 2 ]; then
    echo '[]'
    exit 0
  fi
  if [ "$SCENARIO" = "changed" ] && [ "$count" -gt 1 ]; then
    printf 'hosted notice query changed\n' >&2
  elif [ "$SCENARIO" = "escape" ]; then
    printf '\\033[2Jhosted notice query unavailable\n' >&2
  elif [ "$SCENARIO" = "credential" ]; then
    credential_name="to""ken"
    credential_value="example""-credential"
    printf '%s=%s\n' "$credential_name" "$credential_value" >&2
  elif [ "$SCENARIO" = "compound-key" ]; then
    credential_name="AWS_""ACCESS_""KEY_""ID"
    credential_value="example""-credential"
    printf '%s=%s\n' "$credential_name" "$credential_value" >&2
  elif [ "$SCENARIO" = "json-key" ]; then
    credential_name="api_""key"
    credential_value="example""-credential"
    printf '{"%s": "%s"}\n' "$credential_name" "$credential_value" >&2
  elif [ "$SCENARIO" = "yaml-secret" ]; then
    credential_name="client_""secret"
    credential_value="example""-credential"
    printf '%s: %s\n' "$credential_name" "$credential_value" >&2
  elif [ "$SCENARIO" = "literal-backslash" ]; then
    printf '%s\n' '\\033[2Jordinary notice query failure' >&2
  elif [ "$SCENARIO" = "empty-binary" ]; then
    if [ "$count" -gt 1 ]; then
      printf '\\000\\001\\002' >&2
    fi
  elif [ "$SCENARIO" = "empty" ]; then
    :
  elif [ "$SCENARIO" = "long" ]; then
    i=0
    while [ "$i" -lt 100 ]; do
      printf 'ab-' >&2
      i=$((i + 1))
    done
    printf '\n' >&2
  else
    printf 'hosted\tnotice query unavailable\nignored second line\n' >&2
  fi
  exit 7
elif [ "$1" = "monitor" ] && [ "$2" = "--lock-holder" ]; then
  echo '{}'
else
  exit 2
fi
`,
  )
  chmodSync(orch, 0o755)

  try {
    const runScenario = (
      scenario: string,
      keepaliveTicks = 100,
      diagnostic = 'monitor notices unavailable',
      maxTicks = 3,
      xpgEcho = false,
    ) => {
      rmSync(counterPath, { force: true })
      const result = Bun.spawnSync(
        [
          'bash',
          ...(xpgEcho ? ['-O', 'xpg_echo'] : []),
          join(hooks, 'orch-heartbeat.sh'),
          'notice-failure-session',
          '0',
          String(maxTicks),
        ],
        {
          cwd: fixture,
          env: {
            ...process.env,
            ORCH_DB: join(fixture, 'absent.db'),
            KEEPALIVE_TICKS: String(keepaliveTicks),
            NOTICE_TIMEOUT_SECONDS: '1',
            COUNTER_PATH: counterPath,
            SCENARIO: scenario,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      expect(result.exitCode).toBe(0)
      return result.stdout
        .toString()
        .split('\n')
        .filter((line) => line.includes(diagnostic))
    }

    const unchanged = runScenario('unchanged')
    expect(unchanged).toHaveLength(1)
    expect(unchanged[0]).toContain('reason=hostednotice query unavailable)')
    expect(unchanged[0]).not.toContain('ignored second line')

    const changed = runScenario('changed')
    expect(changed).toHaveLength(2)
    expect(changed[1]).toContain('reason=hosted notice query changed)')

    const recovered = runScenario('recovery')
    expect(recovered).toHaveLength(2)
    expect(recovered[0]?.replace(/^\[[^\]]+\] /, '')).toBe(
      recovered[1]?.replace(/^\[[^\]]+\] /, ''),
    )

    expect(runScenario('keepalive', 2)).toHaveLength(2)

    expect(runScenario('empty', 100, 'monitor notices unavailable', 1)[0]).toContain(
      'reason=stderr empty)',
    )
    const escaped = runScenario('escape', 100, 'monitor notices unavailable', 1)[0]
    expect(escaped).toContain('reason=[2Jhosted notice query unavailable)')
    expect(escaped).not.toContain('\u001b')

    expect(runScenario('credential', 100, 'monitor notices unavailable', 1)[0]).toContain(
      'reason withheld (secret-shaped)',
    )
    const literalBackslash = runScenario(
      'literal-backslash',
      100,
      'monitor notices unavailable',
      1,
      true,
    )[0]
    expect(literalBackslash).toContain('reason=\\033[2Jordinary notice query failure)')
    expect(literalBackslash).not.toContain('\u001b')

    for (const scenario of ['compound-key', 'json-key', 'yaml-secret']) {
      expect(runScenario(scenario, 100, 'monitor notices unavailable', 1)[0]).toContain(
        'reason withheld (secret-shaped)',
      )
    }

    expect(runScenario('unchanged', 100, 'monitor notices unavailable', 1)[0]).toContain(
      'reason=hostednotice query unavailable)',
    )

    const emptyThenBinary = runScenario('empty-binary')
    expect(emptyThenBinary).toHaveLength(2)
    expect(emptyThenBinary[0]).toContain('reason=stderr empty)')
    expect(emptyThenBinary[1]).toContain('reason=stderr not printable)')

    const longReason = runScenario('long', 100, 'monitor notices unavailable', 1)[0]?.match(
      /reason=(.*)\)\. Health/,
    )?.[1]
    expect(longReason).toHaveLength(240)
  } finally {
    rmSync(fixture, { recursive: true })
  }
}, 30_000)

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
