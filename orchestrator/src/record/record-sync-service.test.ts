import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { syncHostedRecord } from './record-sync-service.ts'

const actorUrl = process.env.BOTTEGA_RECORD_URL
const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const realPostgres = actorUrl && adminUrl ? describe : describe.skip

const SPACE_ID = '01990000-0000-7000-8000-000000001771'
const USER_ID = '01990000-0000-7000-8000-000000001772'
const MEMBERSHIP_ID = '01990000-0000-7000-8000-000000001773'
const PROJECT_ID = '01990000-0000-7000-8000-000000001774'
const MACHINE_ID = '01990000-0000-7000-8000-000000001775'
const TASK_ID = '01990000-0000-7000-8000-000000001776'
const UNKNOWN_TASK_ID = '01990000-0000-7000-8000-000000001777'
const LINKED_RUN_ID = '01990000-0000-7000-8000-000000001778'
const UNKNOWN_RUN_ID = '01990000-0000-7000-8000-000000001779'
const OTHER_SPACE_ID = '01990000-0000-7000-8000-000000001780'
const OTHER_SPACE_TASK_ID = '01990000-0000-7000-8000-000000001781'
const CROSS_SPACE_RUN_ID = '01990000-0000-7000-8000-000000001782'
const JSONB_SPACE_ID = '01990000-0000-7000-8000-000000001885'
const JSONB_USER_ID = '01990000-0000-7000-8000-000000001886'
const JSONB_MEMBERSHIP_ID = '01990000-0000-7000-8000-000000001887'
const JSONB_PROJECT_ID = '01990000-0000-7000-8000-000000001888'
const JSONB_MACHINE_ID = '01990000-0000-7000-8000-000000001889'
const JSONB_RUN_ID = '01990000-0000-7000-8000-000000001890'
const JSONB_OVERRIDE_ID = '01990000-0000-7000-8000-000000001891'
const CLAIM_SPACE_ID = '01990000-0000-7000-8000-000000001892'
const CLAIM_USER_ID = '01990000-0000-7000-8000-000000001893'
const CLAIM_MEMBERSHIP_ID = '01990000-0000-7000-8000-000000001894'
const CLAIM_PROJECT_ID = '01990000-0000-7000-8000-000000001895'
const CLAIM_HOLDER_ID = '01990000-0000-7000-8000-000000001896'
const CLAIM_REQUESTER_ID = '01990000-0000-7000-8000-000000001897'
const CLAIM_ID = '01990000-0000-7000-8000-000000001898'
const CLAIM_RUN_ID = '01990000-0000-7000-8000-000000001899'
const STAMP = '2026-10-26T06:00:00.000Z'

function runPayload(id: string, taskId: string | null) {
  const payload = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.run.columns.map((column) => [column, null]),
  )
  return Object.assign(payload, {
    id,
    spaceId: SPACE_ID,
    projectId: PROJECT_ID,
    projectName: 'run-task-proof',
    machineId: MACHINE_ID,
    localId: 1,
    startedAt: STAMP,
    finishedAt: STAMP,
    agent: 'codex',
    job: 'implement',
    promptSha: 'prompt',
    promptBytes: 6,
    promptHead: 'prompt',
    taskKey: 'DEV-1771',
    taskId,
    probe: false,
    status: 'ok',
    turn: 1,
    noFailover: false,
    automaticFailover: false,
    workPreserved: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
}

async function push(client: SQL, id: number, payload: Record<string, unknown>) {
  return syncHostedRecord({
    url: actorUrl!,
    postgres: client,
    identity: {
      user: { id: USER_ID },
      activeSpaceId: SPACE_ID,
      personalSpaceId: SPACE_ID,
      memberships: [{ space_id: SPACE_ID, slug: 'run-task-proof', permission: 'write' }],
    },
    request: {
      machine: { id: MACHINE_ID, name: 'run-task-proof', seenAt: STAMP },
      rows: [{ id, kind: 'run', payload: JSON.stringify(payload), spaceHint: null }],
    },
  })
}

realPostgres('hosted run task references', () => {
  test('resolves task ids and keys in the run space without clearing an existing link', async () => {
    const admin = new SQL(adminUrl!)
    const actor = new SQL(actorUrl!)
    try {
      await admin`INSERT INTO space (id,name,slug,created_at)
        VALUES (${SPACE_ID}::uuid,'Run task proof','run-task-proof',now())`
      await admin`INSERT INTO space (id,name,slug,created_at)
        VALUES (${OTHER_SPACE_ID}::uuid,'Other run task proof','other-run-task-proof',now())`
      await admin`INSERT INTO "user" (id,email,name,created_at)
        VALUES (${USER_ID}::uuid,'run-task-proof@example.test','Run Task Proof',now())`
      await admin`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${MEMBERSHIP_ID}::uuid,${SPACE_ID}::uuid,${USER_ID}::uuid,'member','write',now())`
      await admin`INSERT INTO project (id,space_id,name,key_prefixes,created_at)
        VALUES (${PROJECT_ID}::uuid,${SPACE_ID}::uuid,'run-task-proof',ARRAY['DEV'],now())`
      await admin`INSERT INTO hub_task
        (id,space_id,project_name,project_id,key,project,title,status,status_category,source,first_seen,last_seen,created_at,updated_at)
        VALUES (${TASK_ID}::uuid,${SPACE_ID}::uuid,'run-task-proof',${PROJECT_ID}::uuid,'DEV-1771','run-task-proof',
          'Run task proof','active','active','local',now(),now(),now(),now())`
      await admin`INSERT INTO hub_task
        (id,space_id,project_name,key,project,title,status,status_category,source,first_seen,last_seen,created_at,updated_at)
        VALUES (${OTHER_SPACE_TASK_ID}::uuid,${OTHER_SPACE_ID}::uuid,'other-run-task-proof','OTHER-1771','other-run-task-proof',
          'Other run task proof','active','active','local',now(),now(),now(),now())`

      expect(await push(actor, 1, runPayload(LINKED_RUN_ID, TASK_ID))).toEqual({
        results: [{ id: 1, status: 'synced' }],
      })
      expect(await push(actor, 2, runPayload(LINKED_RUN_ID, null))).toEqual({
        results: [{ id: 2, status: 'synced' }],
      })
      const omitted = runPayload(LINKED_RUN_ID, null)
      Reflect.deleteProperty(omitted, 'taskId')
      expect(await push(actor, 3, omitted)).toEqual({
        results: [{ id: 3, status: 'synced' }],
      })
      expect(await push(actor, 4, runPayload(UNKNOWN_RUN_ID, UNKNOWN_TASK_ID))).toEqual({
        results: [{ id: 4, status: 'synced' }],
      })
      const crossSpace = runPayload(CROSS_SPACE_RUN_ID, OTHER_SPACE_TASK_ID)
      crossSpace.taskKey = 'OTHER-MISSING'
      expect(await push(actor, 5, crossSpace)).toEqual({
        results: [{ id: 5, status: 'synced' }],
      })

      const rows = await admin<{ id: string; task_id: string | null }[]>`
        SELECT id::text,task_id::text FROM run
        WHERE id IN (${LINKED_RUN_ID}::uuid,${UNKNOWN_RUN_ID}::uuid,${CROSS_SPACE_RUN_ID}::uuid)
        ORDER BY id`
      expect([...rows]).toEqual([
        { id: LINKED_RUN_ID, task_id: TASK_ID },
        { id: UNKNOWN_RUN_ID, task_id: TASK_ID },
        { id: CROSS_SPACE_RUN_ID, task_id: null },
      ])
    } finally {
      await admin`DELETE FROM run WHERE id IN (${LINKED_RUN_ID}::uuid,${UNKNOWN_RUN_ID}::uuid,${CROSS_SPACE_RUN_ID}::uuid)`
      await admin`DELETE FROM hub_task WHERE id IN (${TASK_ID}::uuid)`
      await admin`DELETE FROM hub_task WHERE id=${OTHER_SPACE_TASK_ID}::uuid`
      await admin`DELETE FROM project WHERE id=${PROJECT_ID}::uuid`
      await admin`DELETE FROM machine WHERE id=${MACHINE_ID}::uuid`
      await admin`DELETE FROM hub_change WHERE space_id IN (${SPACE_ID}::uuid,${OTHER_SPACE_ID}::uuid)`
      await admin`DELETE FROM hub_change_head WHERE space_id IN (${SPACE_ID}::uuid,${OTHER_SPACE_ID}::uuid)`
      await admin`DELETE FROM membership WHERE id=${MEMBERSHIP_ID}::uuid`
      await admin`DELETE FROM space WHERE id=${SPACE_ID}::uuid`
      await admin`DELETE FROM space WHERE id=${OTHER_SPACE_ID}::uuid`
      await admin`DELETE FROM "user" WHERE id=${USER_ID}::uuid`
      await Promise.all([actor.close(), admin.close()])
    }
  })
})

realPostgres('hosted machine name claims', () => {
  test('a held name leaves canonical names and claims unset while syncing rows', async () => {
    const admin = new SQL(adminUrl!)
    const actor = new SQL(actorUrl!)
    try {
      await admin`INSERT INTO space (id,name,slug,created_at)
        VALUES (${CLAIM_SPACE_ID}::uuid,'Machine claim proof','machine-claim-proof',now())`
      await admin`INSERT INTO "user" (id,email,name,created_at)
        VALUES (${CLAIM_USER_ID}::uuid,'machine-claim-proof@example.test','Machine Claim Proof',now())`
      await admin`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${CLAIM_MEMBERSHIP_ID}::uuid,${CLAIM_SPACE_ID}::uuid,${CLAIM_USER_ID}::uuid,
          'member','write',now())`
      await admin`INSERT INTO project (id,space_id,name,key_prefixes,created_at)
        VALUES (${CLAIM_PROJECT_ID}::uuid,${CLAIM_SPACE_ID}::uuid,'machine-claim-proof',ARRAY['DEV'],now())`
      await admin`INSERT INTO machine
        (id,user_id,name,short_name,display_name,registered_at,last_seen)
        VALUES (${CLAIM_HOLDER_ID}::uuid,${CLAIM_USER_ID}::uuid,'Holder machine','held-name',
          'Holder machine',${STAMP}::timestamptz,${STAMP}::timestamptz)`
      await admin`INSERT INTO machine_name_claim (id,space_id,short_name,machine_id,claimed_at)
        VALUES (${CLAIM_ID}::uuid,${CLAIM_SPACE_ID}::uuid,'held-name',${CLAIM_HOLDER_ID}::uuid,
          ${STAMP}::timestamptz)`

      const run = runPayload(CLAIM_RUN_ID, null)
      Object.assign(run, {
        spaceId: CLAIM_SPACE_ID,
        projectId: CLAIM_PROJECT_ID,
        projectName: 'machine-claim-proof',
        machineId: CLAIM_REQUESTER_ID,
        taskKey: null,
      })
      const result = await syncHostedRecord({
        url: actorUrl!,
        postgres: actor,
        identity: {
          user: { id: CLAIM_USER_ID },
          activeSpaceId: CLAIM_SPACE_ID,
          personalSpaceId: CLAIM_SPACE_ID,
          memberships: [
            { space_id: CLAIM_SPACE_ID, slug: 'machine-claim-proof', permission: 'write' },
          ],
        },
        request: {
          machine: {
            id: CLAIM_REQUESTER_ID,
            name: 'requesting-client-default',
            shortName: 'held-name',
            displayName: 'Requested display',
            seenAt: STAMP,
          },
          rows: [{ id: 1, kind: 'run', payload: JSON.stringify(run), spaceHint: null }],
        },
      })

      expect(result).toEqual({
        results: [{ id: 1, status: 'synced' }],
        machineNameRefusal: `short name held-name is held by Holder machine (held-name); choose another with \`${PLATFORM_SLUG} machine rename --short-name <name>\``,
      })
      const [machine] = await admin<
        { name: string; short_name: string | null; display_name: string | null }[]
      >`SELECT name,short_name,display_name FROM machine WHERE id=${CLAIM_REQUESTER_ID}::uuid`
      expect(machine).toEqual({
        name: 'requesting-client-default',
        short_name: null,
        display_name: null,
      })
      const [effects] = await admin<{ claims: number; runs: number }[]>`
        SELECT
          (SELECT count(*)::int FROM machine_name_claim WHERE machine_id=${CLAIM_REQUESTER_ID}::uuid) AS claims,
          (SELECT count(*)::int FROM run WHERE id=${CLAIM_RUN_ID}::uuid) AS runs`
      expect(effects).toEqual({ claims: 0, runs: 1 })
    } finally {
      await admin`DELETE FROM run WHERE id=${CLAIM_RUN_ID}::uuid`
      await admin`DELETE FROM machine_name_claim WHERE id=${CLAIM_ID}::uuid`
      await admin`DELETE FROM machine WHERE id IN (${CLAIM_REQUESTER_ID}::uuid,${CLAIM_HOLDER_ID}::uuid)`
      await admin`DELETE FROM project WHERE id=${CLAIM_PROJECT_ID}::uuid`
      await admin`DELETE FROM hub_change WHERE space_id=${CLAIM_SPACE_ID}::uuid`
      await admin`DELETE FROM hub_change_head WHERE space_id=${CLAIM_SPACE_ID}::uuid`
      await admin`DELETE FROM membership WHERE id=${CLAIM_MEMBERSHIP_ID}::uuid`
      await admin`DELETE FROM space WHERE id=${CLAIM_SPACE_ID}::uuid`
      await admin`DELETE FROM "user" WHERE id=${CLAIM_USER_ID}::uuid`
      await Promise.all([actor.close(), admin.close()])
    }
  })
})

realPostgres('hosted jsonb sync values', () => {
  test('writes structured run and landing override values through the real sync path', async () => {
    const admin = new SQL(adminUrl!)
    const actor = new SQL(actorUrl!)
    try {
      await admin`INSERT INTO space (id,name,slug,created_at)
        VALUES (${JSONB_SPACE_ID}::uuid,'JSONB sync proof','jsonb-sync-proof',now())`
      await admin`INSERT INTO "user" (id,email,name,created_at)
        VALUES (${JSONB_USER_ID}::uuid,'jsonb-sync-proof@example.test','JSONB Sync Proof',now())`
      await admin`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${JSONB_MEMBERSHIP_ID}::uuid,${JSONB_SPACE_ID}::uuid,${JSONB_USER_ID}::uuid,
          'member','write',now())`
      await admin`INSERT INTO project (id,space_id,name,key_prefixes,created_at)
        VALUES (${JSONB_PROJECT_ID}::uuid,${JSONB_SPACE_ID}::uuid,'jsonb-sync-proof',ARRAY['DEV'],now())`

      const run = runPayload(JSONB_RUN_ID, null)
      Object.assign(run, {
        spaceId: JSONB_SPACE_ID,
        projectId: JSONB_PROJECT_ID,
        projectName: 'jsonb-sync-proof',
        machineId: JSONB_MACHINE_ID,
        changedPaths: ['changed.ts'],
        docRevisions: ['doc@1'],
        outsideWorktreeWrites: ['outside.ts'],
        reviewProvenance: { review: 'accepted' },
        provisioningPhases: [{ phase: 'create' }],
        provisioningHostLoad: { gates: 1 },
        provisioningEntryRoots: ['/worktree'],
        withheldFields: ['secret'],
      })
      const override = Object.assign(
        Object.fromEntries(
          OUTBOX_PAYLOAD_CONTRACTS.landing_override.columns.map((column) => [column, null]),
        ),
        {
          id: JSONB_OVERRIDE_ID,
          spaceId: JSONB_SPACE_ID,
          projectId: JSONB_PROJECT_ID,
          projectName: 'jsonb-sync-proof',
          machineId: JSONB_MACHINE_ID,
          localId: 1,
          branch: 'DEV-1885-jsonb',
          tip: 'tip',
          tree: 'tree',
          pathSet: ['changed.ts'],
          reason: 'gate proof',
          attribution: 'operator',
          missingLenses: ['correctness'],
          at: STAMP,
          withheldFields: ['secret'],
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      )

      expect(
        await syncHostedRecord({
          url: actorUrl!,
          postgres: actor,
          identity: {
            user: { id: JSONB_USER_ID },
            activeSpaceId: JSONB_SPACE_ID,
            personalSpaceId: JSONB_SPACE_ID,
            memberships: [
              { space_id: JSONB_SPACE_ID, slug: 'jsonb-sync-proof', permission: 'write' },
            ],
          },
          request: {
            machine: { id: JSONB_MACHINE_ID, name: 'jsonb-sync-proof', seenAt: STAMP },
            rows: [
              { id: 1, kind: 'run', payload: JSON.stringify(run), spaceHint: null },
              {
                id: 2,
                kind: 'landing_override',
                payload: JSON.stringify(override),
                spaceHint: null,
              },
            ],
          },
        }),
      ).toEqual({
        results: [
          { id: 1, status: 'synced' },
          { id: 2, status: 'synced' },
        ],
      })

      const [runTypes] = await admin`
        SELECT jsonb_typeof(changed_paths) AS changed_paths,
          jsonb_typeof(doc_revisions) AS doc_revisions,
          jsonb_typeof(outside_worktree_writes) AS outside_worktree_writes,
          jsonb_typeof(review_provenance) AS review_provenance,
          jsonb_typeof(provisioning_phases) AS provisioning_phases,
          jsonb_typeof(provisioning_host_load) AS provisioning_host_load,
          jsonb_typeof(provisioning_entry_roots) AS provisioning_entry_roots,
          jsonb_typeof(withheld_fields) AS withheld_fields
        FROM run WHERE id=${JSONB_RUN_ID}::uuid`
      expect(runTypes).toEqual({
        changed_paths: 'array',
        doc_revisions: 'array',
        outside_worktree_writes: 'array',
        review_provenance: 'object',
        provisioning_phases: 'array',
        provisioning_host_load: 'object',
        provisioning_entry_roots: 'array',
        withheld_fields: 'array',
      })
      const [overrideTypes] = await admin`
        SELECT jsonb_typeof(path_set) AS path_set,
          jsonb_typeof(missing_lenses) AS missing_lenses,
          jsonb_typeof(withheld_fields) AS withheld_fields
        FROM landing_override WHERE id=${JSONB_OVERRIDE_ID}::uuid`
      expect(overrideTypes).toEqual({
        path_set: 'array',
        missing_lenses: 'array',
        withheld_fields: 'array',
      })
    } finally {
      await admin`DELETE FROM landing_override WHERE id=${JSONB_OVERRIDE_ID}::uuid`
      await admin`DELETE FROM run WHERE id=${JSONB_RUN_ID}::uuid`
      await admin`DELETE FROM project WHERE id=${JSONB_PROJECT_ID}::uuid`
      await admin`DELETE FROM machine WHERE id=${JSONB_MACHINE_ID}::uuid`
      await admin`DELETE FROM hub_change WHERE space_id=${JSONB_SPACE_ID}::uuid`
      await admin`DELETE FROM hub_change_head WHERE space_id=${JSONB_SPACE_ID}::uuid`
      await admin`DELETE FROM membership WHERE id=${JSONB_MEMBERSHIP_ID}::uuid`
      await admin`DELETE FROM space WHERE id=${JSONB_SPACE_ID}::uuid`
      await admin`DELETE FROM "user" WHERE id=${JSONB_USER_ID}::uuid`
      await Promise.all([actor.close(), admin.close()])
    }
  })
})
