import { expect, test } from 'bun:test'
import { pidAlive, processSignalOutcome } from './process-identity.ts'

test('a process signal outcome distinguishes delivery, absence, denial, and unknown errors', () => {
  expect(processSignalOutcome()).toBe('delivered')
  expect(processSignalOutcome(Object.assign(new Error('no such process'), { code: 'ESRCH' }))).toBe(
    'absent',
  )
  expect(
    processSignalOutcome(Object.assign(new Error('operation not permitted'), { code: 'EPERM' })),
  ).toBe('denied')
  expect(
    processSignalOutcome(Object.assign(new Error('invalid argument'), { code: 'EINVAL' })),
  ).toBe('unknown')
})

test('the current process is alive', () => {
  expect(pidAlive(process.pid)).toBe(true)
})

test('pid 1 exists even when the operating system denies signaling it', () => {
  expect(pidAlive(1)).toBe(true)
})

test('an absent pid is dead', () => {
  expect(pidAlive(null)).toBe(false)
  expect(pidAlive(0)).toBe(false)
})
