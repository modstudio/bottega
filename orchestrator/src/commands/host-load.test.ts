import { beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  boundedJsonLinePath,
  writeBoundedJsonLine,
} from '../../../shared/bounded-json-lines-log.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { dir as suiteDir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { setContentionRolledThroughDay } from '../database/contention-rollup-state.ts'
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

test('a load window beyond retained contention reports its raw horizon', async () => {
  const database = db()
  const now = Date.parse('2026-10-30T17:30:00.000Z')
  writeBoundedJsonLine(
    { at: '2026-10-30T17:29:00.000Z', cpuBusy: 1, swapUsed: 2, loadavg1: 3 },
    { env, maxBytes: 4_096, name: HOST_LOAD_LOG_NAME },
  )
  setContentionRolledThroughDay(database, '2026-10-29')
  const output: string[] = []
  try {
    await hostLoadCommand(
      database,
      { since: '15d', json: false },
      { env, now: () => now, write: async (value) => void output.push(value) },
    )
    expect(output.pop()).toContain(
      'contention waits before 2026-10-16T17:30:00.000Z are outside the raw window',
    )

    await hostLoadCommand(
      database,
      { since: '15d', json: true },
      { env, now: () => now, write: async (value) => void output.push(value) },
    )
    expect(JSON.parse(output.pop()!).contentionRawHorizon).toBe('2026-10-16T17:30:00.000Z')
  } finally {
    setContentionRolledThroughDay(database, null)
  }
})
