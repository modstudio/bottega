import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { LandingTreeHoldKind } from '../landing-tree/landing-tree.ts'
import { upsertProject } from '../project/projects.ts'
import { annotateHeldLandingInFlight, lookupOpenPr } from './close-out-in-flight.ts'

afterEach(() => {
  mock.restore()
})

function insertCursor(input: {
  project: string
  session: string
  branch: string
  worktree: string
  step?: string
}): number {
  const row = db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at)
       VALUES (?,?,(SELECT record_id FROM project WHERE name=?),'ship-task','merge',?,?,?,1,1,?,0,?,'running','[]',NULL,1,'2026-10-22','2026-10-22')
       RETURNING id`,
    )
    .get(
      newRecordId(),
      input.project,
      input.project,
      input.branch,
      input.worktree,
      input.session,
      JSON.stringify({ branch: input.branch, worktree: input.worktree }),
      input.step ?? 'merge-pr',
    ) as { id: number }
  return row.id
}

function heldResult(
  runId: string,
  worktree: string,
  detail: string,
  hold: LandingTreeHoldKind = 'landing-progress',
) {
  return { runId, worktree, outcome: 'held' as const, detail, hold }
}

describe('close-out in-flight hold annotation', () => {
  test('kept reports are not annotated', () => {
    expect(
      annotateHeldLandingInFlight({
        runId: 'kept-1',
        worktree: '/tmp/orch-kept',
        outcome: 'held',
        reportOutcome: 'kept',
        detail: 'clean landing tree; branch DEV-1594 holds its work',
      }).detail,
    ).toBe('clean landing tree; branch DEV-1594 holds its work')
  })

  test('a matching worktree cursor prefixes an in-flight landing hold', () => {
    const id = addRun({ agent: '(architect)', job: 'landing-tree', session: 'owner' })
    const project = `in-flight-${id}`
    const tree = `/tmp/orch-in-flight-${id}`
    const branch = `DEV-1594-${id}`
    upsertProject({ recordId: newRecordId(), name: project, path: `/repo/${project}` })
    db()
      .query("UPDATE run SET repo=?, branch=?, worktree=?, session_id='owner' WHERE record_id=?")
      .run(project, branch, tree, id)
    const cursorId = insertCursor({
      project,
      session: 'owner',
      branch,
      worktree: tree,
    })

    const annotated = annotateHeldLandingInFlight(
      heldResult(id, tree, 'landing tree held by session owner: landing is in flight'),
    )

    expect(annotated.detail).toBe(
      `in flight (cursor ${cursorId} merge-pr); landing tree held by session owner: landing is in flight`,
    )
    expect(annotated.inFlightRef).toBe(`cursor ${cursorId} merge-pr`)
    expect(annotated.suppressBlock).toBe(true)
  })

  test('a cursor for another tree or project does not suppress the hold', () => {
    const id = addRun({ agent: '(architect)', job: 'landing-tree', session: 'owner' })
    const project = `in-flight-other-${id}`
    const tree = `/tmp/orch-in-flight-${id}`
    const branch = `DEV-1594-${id}`
    upsertProject({ recordId: newRecordId(), name: project, path: `/repo/${project}` })
    upsertProject({
      recordId: newRecordId(),
      name: `${project}-other`,
      path: `/repo/${project}-other`,
    })
    db()
      .query("UPDATE run SET repo=?, branch=?, worktree=?, session_id='owner' WHERE record_id=?")
      .run(project, branch, tree, id)
    insertCursor({
      project,
      session: 'owner',
      branch,
      worktree: `${tree}-other`,
    })
    insertCursor({
      project: `${project}-other`,
      session: 'owner',
      branch,
      worktree: tree,
    })

    const annotated = annotateHeldLandingInFlight(
      heldResult(id, tree, 'landing tree held by session owner: landing is in flight'),
    )

    expect(annotated.detail).toBe('landing tree held by session owner: landing is in flight')
    expect(annotated.inFlightRef).toBeNull()
    expect(annotated.suppressBlock).toBe(false)
  })

  test('a dirty unique-work hold keeps the matching cursor as a suffix', () => {
    const id = addRun({ agent: '(architect)', job: 'landing-tree', session: 'owner' })
    const project = `in-flight-dirty-${id}`
    const tree = `/tmp/orch-in-flight-dirty-${id}`
    const branch = `DEV-1594-${id}`
    upsertProject({ recordId: newRecordId(), name: project, path: `/repo/${project}` })
    db()
      .query("UPDATE run SET repo=?, branch=?, worktree=?, session_id='owner' WHERE record_id=?")
      .run(project, branch, tree, id)
    const cursorId = insertCursor({
      project,
      session: 'owner',
      branch,
      worktree: tree,
    })

    const annotated = annotateHeldLandingInFlight(
      heldResult(id, tree, 'landing tree held by session owner: tree is dirty', 'unique-work'),
    )

    expect(annotated.detail).toBe(
      `landing tree held by session owner: tree is dirty; in flight (cursor ${cursorId} merge-pr)`,
    )
    expect(annotated.inFlightRef).toBe(`cursor ${cursorId} merge-pr`)
    expect(annotated.suppressBlock).toBe(false)
  })

  test('lookupOpenPr reads an open PR number', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'close-out-pr-'))
    mkdirSync(cwd, { recursive: true })
    spyOn(Bun, 'spawnSync').mockImplementation((() => {
      return {
        exitCode: 0,
        stdout: Buffer.from('[{"number":88}]'),
        stderr: Buffer.from(''),
        success: true,
        exitedDueToTimeout: false,
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync)
    try {
      expect(lookupOpenPr(cwd, 'DEV-1594-ship')).toBe('#88')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
