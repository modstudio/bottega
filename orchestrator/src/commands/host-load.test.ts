import { beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { boundedJsonLinePath } from '../../../shared/bounded-json-lines-log.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { dir as suiteDir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { HOST_LOAD_LOG_NAME } from '../host-load-series.ts'
import { hostLoadCommand } from './host-load.ts'

const trackResidue = trackedTestResidue()
let env: NodeJS.ProcessEnv

beforeEach(() => {
  const state = trackResidue(join(suiteDir, `host-load-command-${crypto.randomUUID()}`))
  env = { ...process.env, [STATE_HOME_ENV]: state }
})

test('an empty sample window refuses with the canonical log path', async () => {
  const path = boundedJsonLinePath(HOST_LOAD_LOG_NAME, env)
  await expect(
    hostLoadCommand(
      db(),
      { json: true },
      { env, now: () => Date.parse('2026-10-30T17:30:00.000Z'), write: async () => {} },
    ),
  ).rejects.toThrow(`host load window has no samples in ${path}`)
})
