import { expect, test } from 'bun:test'
import { pidAlive } from './process-identity.ts'

test('the current process is alive', () => {
  expect(pidAlive(process.pid)).toBe(true)
})

test('a process that cannot be signaled is alive', () => {
  expect(
    pidAlive(999_999_999, () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }),
  ).toBe(true)
})

test('a missing process is dead', () => {
  expect(
    pidAlive(999_999_999, () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }),
  ).toBe(false)
})

test('an absent pid is dead without checking the operating system', () => {
  let calls = 0
  const kill = () => {
    calls += 1
    return true
  }

  expect(pidAlive(null, kill)).toBe(false)
  expect(pidAlive(0, kill)).toBe(false)
  expect(calls).toBe(0)
})
