import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { databaseLockHolderCommandSummary } from './database-lock-refusal.ts'
import { STATE_HOME_ENV } from './state-directory.ts'
import {
  MACHINE_UPDATE_LOCK_HELD_ENV,
  machineUpdateLockHeldEnvironment,
  machineUpdateLockRefusal,
  withMachineUpdateLock,
  withMachineUpdateLockUnlessHeld,
} from './update-lock.ts'

function temporaryState(): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'machine-update-lock.'))
  return { root, env: { [STATE_HOME_ENV]: root } }
}

test('machine update lock refusal names the holder and rerun remedy', () => {
  const command = `/opt/bun /opt/app/${PLATFORM_SLUG}.ts machine update --token fixture-secret`
  expect(machineUpdateLockRefusal({ pid: 4321, command })).toBe(
    `another update is running: pid 4321, command bun ${PLATFORM_SLUG}.ts; wait for it to finish, then rerun ${PLATFORM_SLUG} machine update`,
  )
})

test('machine update lock refusal accepts the refused migrate verb', () => {
  expect(machineUpdateLockRefusal(null, 'machine migrate')).toEndWith(
    `then rerun ${PLATFORM_SLUG} machine migrate`,
  )
})

test('the held child environment marks the lock as inherited', () => {
  expect(machineUpdateLockHeldEnvironment()).toEqual({ [MACHINE_UPDATE_LOCK_HELD_ENV]: '1' })
})

test('a second waiter acquires the machine update lock after the first releases it', async () => {
  const { root, env } = temporaryState()
  let releaseFirst!: () => void
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  try {
    const first = withMachineUpdateLock(() => held, { env })
    let acquired = false
    await withMachineUpdateLock(
      () => {
        acquired = true
      },
      {
        env,
        waitMs: 100,
        now: () => 0,
        sleep: async () => {
          releaseFirst()
          await first
        },
      },
    )
    expect(acquired).toBeTrue()
  } finally {
    releaseFirst()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a waiter past its bound names the holder from the lock file', async () => {
  const { root, env } = temporaryState()
  let releaseFirst!: () => void
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  try {
    const first = withMachineUpdateLock(() => held, { env })
    const holder = JSON.parse(readFileSync(join(root, 'machine-update.lock'), 'utf8')) as {
      pid: number
      command: string
    }
    await expect(
      withMachineUpdateLock(() => {}, { env, waitMs: 0, now: () => 0, sleep: async () => {} }),
    ).rejects.toThrow(
      `another update is running: pid ${holder.pid}, command ${databaseLockHolderCommandSummary(holder.command)}`,
    )
    releaseFirst()
    await first
  } finally {
    releaseFirst()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the machine update lock can be taken again after completion', async () => {
  const { root, env } = temporaryState()
  const calls: string[] = []
  try {
    await withMachineUpdateLock(() => calls.push('first'), { env })
    await withMachineUpdateLock(() => calls.push('second'), { env })
    expect(calls).toEqual(['first', 'second'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the held marker skips the lock and its absence takes it', async () => {
  const { root, env } = temporaryState()
  try {
    await withMachineUpdateLockUnlessHeld(async () => {
      await expect(
        withMachineUpdateLock(() => {}, { env, waitMs: 0, now: () => 0 }),
      ).rejects.toThrow('another update is running')
    }, env)
    await withMachineUpdateLockUnlessHeld(
      () => withMachineUpdateLock(() => {}, { env, waitMs: 0, now: () => 0 }),
      { ...env, [MACHINE_UPDATE_LOCK_HELD_ENV]: '1' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
