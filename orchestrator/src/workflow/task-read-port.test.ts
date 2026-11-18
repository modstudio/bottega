import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { taskReader } from './task-read-port.ts'

test('an uninstalled task read refuses without a spawn fallback', () => {
  expect(() => taskReader()).toThrow(
    `task reads are unavailable: this process did not install a task reader; start it through ${bottegaEntryArgv(PLATFORM_SLUG)[0]}`,
  )
})
