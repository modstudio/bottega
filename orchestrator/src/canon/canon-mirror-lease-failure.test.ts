import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { db } from '../database/db.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a lease acquisition failure terminalises the synthetic run', async () => {
  const root = mirrorRepository('cm-lease-fail')
  try {
    await registerManagedMirror(root, 'cm-lease-fail')
    const result = await mirrorRepositoryCanon({
      project: 'cm-lease-fail',
      dryRun: false,
      port: mirrorFixturePort(root, {
        acquireLease: () => {
          throw new Error('fixture lease denied')
        },
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('fixture lease denied')
    expect(
      db()
        .query(
          `SELECT status,error FROM run WHERE repo=? AND job='canon-mirror' ORDER BY number DESC LIMIT 1`,
        )
        .get('cm-lease-fail'),
    ).toEqual({ status: 'failed', error: 'fixture lease denied' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a release preparation failure terminalises the synthetic run', async () => {
  const root = mirrorRepository('cm-prepare-release-fail')
  try {
    await registerManagedMirror(root, 'cm-prepare-release-fail')
    const result = await mirrorRepositoryCanon({
      project: 'cm-prepare-release-fail',
      dryRun: false,
      port: mirrorFixturePort(root, {
        prepareRelease: () => Promise.reject(new Error('fixture release preparation denied')),
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('fixture release preparation denied')
    expect(
      db()
        .query(
          `SELECT status,error FROM run WHERE repo=? AND job='canon-mirror' ORDER BY number DESC LIMIT 1`,
        )
        .get('cm-prepare-release-fail'),
    ).toEqual({ status: 'failed', error: 'fixture release preparation denied' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
