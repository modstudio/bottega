import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import type { HeldTreeHoldKind } from '../landing-tree/landing-tree.ts'
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
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,(SELECT record_id FROM project WHERE name=?),'ship-task','merge',?,?,?,?,?, ?,0,?,'running','[]',NULL,1,'2026-10-22','2026-10-22')
       RETURNING number id`,
    )
    .get(
      newRecordId(),
      input.project,
      input.project,
      input.branch,
      input.worktree,
      input.session,
      workflowVersionRecordId(db()),
      catalogueVersionRecordId(db()),
      JSON.stringify({ branch: input.branch, worktree: input.worktree }),
      input.step ?? 'merge-pr',
    ) as { id: number }
  return row.id
}

function heldResult(
  runId: string,
  worktree: string,
  detail: string,
  hold: HeldTreeHoldKind = 'landing-progress',
) {
  return { runId, worktree, outcome: 'held' as const, detail, hold }
}

function ordinaryRunHolding(job = 'implement'): {
  id: string
  tree: string
  project: string
  branch: string
} {
  const id = addRun({ agent: 'codex', job, session: 'owner' })
  const project = `in-flight-run-${id}`
  const branch = `DEV-1752-${id}`
  const tree = mkdtempSync(join(tmpdir(), 'close-out-run-'))
  upsertProject({ recordId: newRecordId(), name: project, path: `/repo/${project}` })
  db()
    .query("UPDATE run SET repo=?, branch=?, worktree=?, session_id='owner' WHERE record_id=?")
    .run(project, branch, tree, id)
  return { id, tree, project, branch }
}

function mockGitAndGh(input: {
  statusOutput: string
  headCommit: string
  statusExitCode?: number
  calls?: string[][]
}): void {
  const answer = (argv: string[]): ReturnType<typeof Bun.spawnSync> => {
    input.calls?.push(argv)
    const [bin, ...args] = argv
    const isStatus = bin !== 'gh' && args[0] === 'status'
    const stdout =
      bin === 'gh'
        ? '[{"number":88,"headRefOid":"sha-head"}]'
        : isStatus
          ? input.statusOutput
          : input.headCommit
    const exitCode = isStatus ? (input.statusExitCode ?? 0) : 0
    return {
      exitCode,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from("git: error: couldn't create cache file (errno=Operation not permitted)"),
      success: exitCode === 0,
      exitedDueToTimeout: false,
    } as ReturnType<typeof Bun.spawnSync>
  }
  spyOn(Bun, 'spawnSync').mockImplementation(answer as unknown as typeof Bun.spawnSync)
}

describe('close-out in-flight hold annotation', () => {
  test('kept reports are not annotated', () => {
    // A run row and a cursor matched to this tree: without them the kept-outcome guard could be
    // deleted and this test would still pass, because the run-row guard would stop the annotation.
    const id = addRun({ agent: '(architect)', job: 'landing-tree', session: 'owner' })
    const project = `in-flight-kept-${id}`
    const tree = `/tmp/orch-in-flight-kept-${id}`
    const branch = `DEV-1594-${id}`
    upsertProject({ recordId: newRecordId(), name: project, path: `/repo/${project}` })
    db()
      .query("UPDATE run SET repo=?, branch=?, worktree=?, session_id='owner' WHERE record_id=?")
      .run(project, branch, tree, id)
    insertCursor({ project, session: 'owner', branch, worktree: tree })

    expect(
      annotateHeldLandingInFlight({
        runId: id,
        worktree: tree,
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

    expect(annotated.detail).toBe(
      `landing tree held by session owner: landing is in flight; ` +
        `cleared by: ${PLATFORM_SLUG} tree remove ${tree}`,
    )
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
      `landing tree held by session owner: tree is dirty; in flight (cursor ${cursorId} merge-pr); ` +
        `cleared by: ${PLATFORM_SLUG} tree remove ${tree}`,
    )
    expect(annotated.inFlightRef).toBe(`cursor ${cursorId} merge-pr`)
    expect(annotated.suppressBlock).toBe(false)
  })

  test('a complete held in-flight annotation is preserved unchanged', () => {
    const { id, tree, project, branch } = ordinaryRunHolding()
    mockGitAndGh({ statusOutput: ' M hub/src/board.ts\n', headCommit: 'sha-head' })
    try {
      insertCursor({ project, session: 'owner', branch, worktree: tree })
      const held = {
        ...heldResult(
          id,
          tree,
          `hook tree; remove with ${PLATFORM_SLUG} tree remove <path>`,
          'other',
        ),
        inFlightRef: 'hook tree, kept by its owner',
        suppressBlock: true,
      }

      expect(annotateHeldLandingInFlight(held)).toBe(held)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  test('lookupOpenPr reads an open PR number and head commit', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'close-out-pr-'))
    mkdirSync(cwd, { recursive: true })
    spyOn(Bun, 'spawnSync').mockImplementation((() => {
      return {
        exitCode: 0,
        stdout: Buffer.from('[{"number":88,"headRefOid":"sha-head"}]'),
        stderr: Buffer.from(''),
        success: true,
        exitedDueToTimeout: false,
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync)
    try {
      expect(lookupOpenPr(cwd, 'DEV-1594-ship')).toEqual({ ref: '#88', headOid: 'sha-head' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('lookupOpenPr reports the ref alone when gh omits the head commit', () => {
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
      expect(lookupOpenPr(cwd, 'DEV-1594-ship')).toEqual({ ref: '#88', headOid: null })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('an other hold blocks at a matching cursor even with a pull request at the tree head', () => {
    const { id, tree, project, branch } = ordinaryRunHolding()
    mockGitAndGh({ statusOutput: ' M hub/src/board.ts\n', headCommit: 'sha-head' })
    try {
      const cursorId = insertCursor({ project, session: 'owner', branch, worktree: tree })

      const annotated = annotateHeldLandingInFlight(
        heldResult(id, tree, `hook tree; remove with ${PLATFORM_SLUG} tree remove <path>`, 'other'),
      )

      expect(annotated.suppressBlock).toBe(false)
      expect(annotated.inFlightRef).toBe(`cursor ${cursorId} merge-pr`)
      expect(annotated.detail).toBe(
        `hook tree; remove with ${PLATFORM_SLUG} tree remove <path>; ` +
          `in flight (cursor ${cursorId} merge-pr); ` +
          `cleared by: ${PLATFORM_SLUG} run discard ${id}`,
      )
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  test('a dirty non-landing-progress hold makes no pull-request lookup', () => {
    const { id, tree } = ordinaryRunHolding()
    const calls: string[][] = []
    mockGitAndGh({ statusOutput: ' M hub/src/board.ts\n', headCommit: 'sha-head', calls })
    try {
      const annotated = annotateHeldLandingInFlight(
        heldResult(id, tree, `hook tree; remove with ${PLATFORM_SLUG} tree remove <path>`, 'other'),
      )

      expect(calls.map(([bin]) => bin)).not.toContain('gh')
      expect(calls.some(([bin, ...args]) => bin === 'git' && args[0] === 'status')).toBe(true)
      expect(annotated.suppressBlock).toBe(false)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  test('an other hold keeps blocking when git status cannot be read', () => {
    const { id, tree } = ordinaryRunHolding()
    mockGitAndGh({ statusOutput: '', headCommit: 'sha-head', statusExitCode: 128 })
    try {
      const annotated = annotateHeldLandingInFlight(
        heldResult(id, tree, 'ordinary run tree is held', 'other'),
      )

      expect(annotated.suppressBlock).toBe(false)
      expect(annotated.inFlightRef).toBeNull()
      expect(annotated.detail).toEndWith(`cleared by: ${PLATFORM_SLUG} run discard ${id}`)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  test('a held reader clone names its close-out lease holder and does not block', () => {
    const { id, tree } = ordinaryRunHolding('review-lens')
    try {
      const run = db().query('SELECT number FROM run WHERE record_id=?').get(id) as {
        number: number
      }
      const annotated = annotateHeldLandingInFlight(
        heldResult(
          id,
          tree,
          `close-out lease for run ${id} is already held; close-out skipped`,
          'close-out-lease',
        ),
      )

      expect(annotated).toMatchObject({
        inFlightRef: `run ${run.number} (review-lens) holds it; clears when it finishes`,
        suppressBlock: true,
      })
      expect(annotated.detail).toStartWith(
        `in flight (run ${run.number} (review-lens) holds it; clears when it finishes); `,
      )
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  test('every held-tree reason that can block Stop carries a takeable remedy', () => {
    const landing = ordinaryRunHolding('landing-tree')
    const ordinary = ordinaryRunHolding()
    const reader = ordinaryRunHolding('review-lens')
    mockGitAndGh({ statusOutput: ' M held-work.txt\n', headCommit: 'sha-head' })
    try {
      const readerNumber = (
        db().query('SELECT number FROM run WHERE record_id=?').get(reader.id) as { number: number }
      ).number
      const rows = [
        {
          reason: 'landing progress without a current cursor',
          expected: 'in-flight',
          result: annotateHeldLandingInFlight(
            heldResult(landing.id, landing.tree, 'landing is in flight', 'landing-progress'),
          ),
          ref: '#88',
        },
        {
          reason: 'unique work',
          expected: 'blocking',
          result: annotateHeldLandingInFlight(
            heldResult(landing.id, landing.tree, 'tree is dirty', 'unique-work'),
          ),
        },
        {
          reason: 'other close-out safety hold',
          expected: 'blocking',
          result: annotateHeldLandingInFlight(
            heldResult(ordinary.id, ordinary.tree, 'ownership could not be established', 'other'),
          ),
        },
        {
          reason: 'writer close-out lease',
          expected: 'blocking',
          result: annotateHeldLandingInFlight(
            heldResult(ordinary.id, ordinary.tree, 'close-out skipped', 'close-out-lease'),
          ),
        },
        {
          reason: 'shared reader close-out lease',
          expected: 'in-flight',
          result: annotateHeldLandingInFlight(
            heldResult(reader.id, reader.tree, 'close-out skipped', 'close-out-lease'),
          ),
          ref: `run ${readerNumber} (review-lens) holds it; clears when it finishes`,
        },
        {
          reason: 'hook tree owner',
          expected: 'in-flight',
          result: annotateHeldLandingInFlight({
            ...heldResult(ordinary.id, ordinary.tree, 'hook tree', 'other'),
            inFlightRef: 'hook tree, kept by its owner',
            suppressBlock: true,
          }),
          ref: 'hook tree, kept by its owner',
        },
      ] as const

      for (const row of rows) {
        if (row.expected === 'in-flight') {
          expect(row.result.suppressBlock, row.reason).toBe(true)
          expect(row.result.inFlightRef, row.reason).toBe(row.ref)
        } else {
          expect(row.result.suppressBlock, row.reason).toBe(false)
          expect(row.result.detail, row.reason).toMatch(
            /cleared by: bottega (?:run discard|tree remove) /,
          )
        }
      }
    } finally {
      rmSync(landing.tree, { recursive: true, force: true })
      rmSync(ordinary.tree, { recursive: true, force: true })
      rmSync(reader.tree, { recursive: true, force: true })
    }
  })
})
