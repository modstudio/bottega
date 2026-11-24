import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso } from '../database/db.ts'
import { recordCreatedWorktreeClaims, settleClaims } from '../resources/resource-claims.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import { trackedAllocator } from './tracked-recipe.ts'

test('a stranded database makes the next root allocate the next rendered index', () => {
  const database = db()
  const projectId = database
    .query<{ record_id: string }, []>(
      "INSERT INTO project(record_id,name,path,canon) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'stopal','/stopal',1) RETURNING record_id",
    )
    .get()!.record_id
  const insertRun = database.query<{ id: string }, [string, string, string]>(
    `INSERT INTO run
     (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id,turn)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','sha',1,'allocation','running',?,1)
     RETURNING record_id AS id`,
  )
  const first = insertRun.get(newRecordId(), nowIso(), projectId)!.id
  const second = insertRun.get(newRecordId(), nowIso(), projectId)!.id
  const recipe: TrackedRecipe = {
    allocate: { databases: { app: { engine: 'postgres', name: 'stopal_orch_{index}' } } },
    create: [],
  }

  expect(trackedAllocator.allocate({ runId: first, recipe, staticVars: {} }).allocations).toEqual({
    index: 1,
    ports: {},
    databases: { app: 'stopal_orch_1' },
    strings: {},
  })
  recordCreatedWorktreeClaims(database, {
    rootRunId: first,
    runId: first,
    projectId,
    owned: true,
    path: '/stopal/tree-one',
    head: 'abc',
    mintedBranch: null,
    label: 'tree-one',
    claimedAt: nowIso(),
  })
  settleClaims(database, {
    rootRunId: first,
    kind: 'worktree',
    state: 'released',
    settledAt: nowIso(),
    detail: 'removed',
    by: { verb: 'close-out:requested', session: 'session-one' },
  })

  expect(trackedAllocator.allocate({ runId: second, recipe, staticVars: {} }).allocations).toEqual({
    index: 2,
    ports: {},
    databases: { app: 'stopal_orch_2' },
    strings: {},
  })
  expect(
    database
      .query(
        "SELECT kind,state FROM resource_claim WHERE root_run_record_id=? AND kind IN ('index','database') ORDER BY kind",
      )
      .all(first),
  ).toEqual([
    { kind: 'database', state: 'claimed' },
    { kind: 'index', state: 'released' },
  ])
})
