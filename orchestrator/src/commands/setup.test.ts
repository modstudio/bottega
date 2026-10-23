import { afterEach, expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { register } from './setup.ts'

const priorRunId = process.env.BOTTEGA_RUN_ID

afterEach(() => {
  if (priorRunId === undefined) delete process.env.BOTTEGA_RUN_ID
  else process.env.BOTTEGA_RUN_ID = priorRunId
})

test('setup restore refuses a worker-marked caller before reading the backup', async () => {
  process.env.BOTTEGA_RUN_ID = 'setup-restore-worker'
  const program = new Command().exitOverride()
  register(program)

  await expect(
    program.parseAsync(['node', PLATFORM_SLUG, 'setup', 'restore', '/does/not/exist']),
  ).rejects.toThrow('refusing setup restore from an orchestrator worker run')
})
