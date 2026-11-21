import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import { ORCH_RUN_MARKER } from '../worktree/worktree-attribution.ts'
import {
  observeNamedRunForSweep,
  orphanClaimRuling,
  orphanCandidateDecision,
} from './cleanup-sweep-orphan-candidate.ts'

test('orphan ruling reads claimed claims and current run pointers from the store', () => {
  const claimRun = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const pointerRun = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const claimedPath = join(dir, `claim-only-${claimRun}`)
  const pointerPath = join(dir, `pointer-only-${pointerRun}`)
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,settled_at)
       VALUES (?,?,?,?, 'worktree', ?,NULL,NULL,'claimed',?,NULL)`,
    )
    .run(newRecordId(), claimRun, claimRun, null, claimedPath, nowIso())
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(pointerPath, pointerRun)

  expect(orphanClaimRuling(db(), claimedPath, 0, false)).toMatchObject({
    action: 'claimed',
    keepLine: `claimed by run(s) ${claimRun} — kept`,
  })
  expect(orphanClaimRuling(db(), pointerPath, 0, false)).toMatchObject({
    action: 'claimed',
    keepLine: `claimed by run(s) ${pointerRun} — kept`,
  })
})

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
