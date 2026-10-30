import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { readerTreeSharingOptions } from './reader-tree-sharing-claim.ts'

const eligible = (callerCwd: string) => ({
  name: 'claude',
  writesJob: false,
  repoJob: true,
  reviewTarget: { commit: '0123456789abcdef0123456789abcdef01234567' },
  mcpRequest: undefined,
  callerCwd,
})

test('claim sharing uses the sandbox project and records fallback provisioning detail', () => {
  const runId = addRun({ agent: 'claude', job: 'review-lens', status: 'running' })
  const unregistered = mkdtempSync(join(tmpdir(), 'reader-sharing-unregistered-'))
  const priorSandbox = process.env.BOTTEGA_SANDBOX
  delete process.env.BOTTEGA_SANDBOX
  try {
    expect(
      readerTreeSharingOptions(eligible(unregistered), runId).sharedReviewCommit,
    ).toBeUndefined()

    const options = readerTreeSharingOptions(eligible(process.cwd()), runId)
    expect(options.sharedReviewCommit).toBe(eligible(process.cwd()).reviewTarget.commit)
    options.recordSharedFallback('tree differs\nfrom the reviewed commit')
    const row = db().query('SELECT provisioning_phases FROM run WHERE record_id=?').get(runId) as {
      provisioning_phases: string
    }
    expect(JSON.parse(row.provisioning_phases)).toEqual([
      {
        phase: 'shared-reader-fallback',
        name: 'tree differs from the reviewed commit',
        durationMs: 0,
      },
    ])
  } finally {
    if (priorSandbox === undefined) delete process.env.BOTTEGA_SANDBOX
    else process.env.BOTTEGA_SANDBOX = priorSandbox
    rmSync(unregistered, { recursive: true, force: true })
  }
})
