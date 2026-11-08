import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { machineUpdateLockRefusal } from './update-lock.ts'

test('machine update lock refusal names the holder and rerun remedy', () => {
  expect(machineUpdateLockRefusal({ pid: 4321, command: 'bottega machine update' })).toBe(
    `another update is running: pid 4321, command bottega machine update; wait for it to finish, then rerun ${PLATFORM_SLUG} machine update`,
  )
})
