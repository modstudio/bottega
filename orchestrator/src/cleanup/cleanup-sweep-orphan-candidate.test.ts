import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import { observeNamedRunForSweep } from './cleanup-sweep-orphan-candidate.ts'

test('named run observation keeps unknown project ownership separate from liveness', () => {
  const projectRecordId = newRecordId()
  const name = `orphan-candidate-${projectRecordId}`
  upsertProject({
    recordId: projectRecordId,
    name,
    path: join(dir, name),
    settings: {},
  })
  const otherProjectRecordId = newRecordId()
  upsertProject({
    recordId: otherProjectRecordId,
    name: `other-${name}`,
    path: join(dir, `other-${name}`),
    settings: {},
  })
  const runId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    projectRecordId: otherProjectRecordId,
  })
  const project = projectByName(name)
  expect(project).not.toBeNull()

  const observation = observeNamedRunForSweep(`orch-${runId}`, project!, runId)
  expect(observation).toMatchObject({ outcome: 'unknown', runId })
  expect(observation.outcome === 'unknown' ? observation.reason : '').toContain(
    'does not match project',
  )
})
