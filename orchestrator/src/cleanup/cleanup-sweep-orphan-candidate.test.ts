import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import { ORCH_RUN_MARKER } from '../worktree/worktree-attribution.ts'
import {
  observeNamedRunForSweep,
  orphanCandidateDecision,
} from './cleanup-sweep-orphan-candidate.ts'

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

test('unknown named-run ownership fails and reports the marked orphan decision', () => {
  const projectRecordId = newRecordId()
  const name = `orphan-candidate-decision-${projectRecordId}`
  const projectPath = join(dir, name)
  upsertProject({ recordId: projectRecordId, name, path: projectPath, settings: {} })
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
  const path = join(projectPath, '.claude', 'worktrees', `orch-${runId}`)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, ORCH_RUN_MARKER), `${runId}\n${projectPath}\n`)
  const errors: string[] = []
  const project = projectByName(name)
  expect(project).not.toBeNull()

  const decision = orphanCandidateDecision(path, project!, `orphan  ${path}`, false, {
    log: () => {},
    error: (...values) => errors.push(values.join(' ')),
    setExitCode: () => {},
    keptBranchLine: String,
  })
  rmSync(projectPath, { recursive: true, force: true })

  expect(decision).toMatchObject({ action: 'keep', line: 'live — kept', failed: true, held: true })
  expect(errors).toEqual([expect.stringContaining(`could not reclaim orphan  ${path}:`)])
})
