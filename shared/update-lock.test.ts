import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { machineUpdateLockRefusal } from './update-lock.ts'

test('machine update lock refusal names the holder and rerun remedy', () => {
  const command = `${PLATFORM_SLUG} machine update`
  expect(machineUpdateLockRefusal({ pid: 4321, command })).toBe(
    `another update is running: pid 4321, command ${command}; wait for it to finish, then rerun ${PLATFORM_SLUG} machine update`,
  )
})
