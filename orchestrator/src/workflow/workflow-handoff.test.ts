import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { decideKeyedRunCursorAdmission } from '../dispatch/keyed-run-cursor-admission.ts'
import { selectBriefInFlight } from '../doc/context-brief.ts'
import { resolveCarriedAttachments } from '../run/run-carried-attachments.ts'
import { taskFlowHandoffLinks, taskFlowReadStore } from './task-flow-store.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import { workflowCursorHandoffLinks } from './workflow-cursor-list.ts'
import { resolveWorkflowCursorContext } from './workflow-cursor-selection.ts'
import {
  admissionEnforcingTaskClaimPorts,
  attachWorkflowFloorArtifact,
  database,
  selectAndNextWorkflowStep,
  testPorts,
} from './workflow-cursor-test.fixture.ts'
import { resolveWorkflowCursorSuccessor } from './workflow-cursor-transition.ts'
import { handoffWorkflow } from './workflow-handoff.ts'
import { attachWorkflowTextByHandle } from './workflow-text.ts'
import { showWorkflowText } from './workflow-text-copy.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

function install(
  d: ReturnType<typeof database>,
  slug: string,
  steps: string[],
  keyRequired = true,
) {
  const draft = setWorkflowLocal(
    slug,
    {
      title: slug,
      description: 'handoff fixture',
      arguments: [
        { name: 'key', required: keyRequired, description: 'Task key.' },
        { name: 'branch', required: true, description: 'Branch.' },
        { name: 'worktree', required: true, description: 'Worktree.' },
      ],
      modes: [{ slug: 'default', title: 'Default', default: true, steps }],
    },
    'handoff fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'handoff fixture', 'test', d)
}

async function keylessFixture() {
  const d = database()
  install(d, 'handoff-keyless-source', ['lens'], false)
  install(d, 'handoff-target', ['score'])
  const context = { session: 'keyless-handoff-session' }
  const opened = await composeWorkflowWithCursor(
    'handoff-keyless-source',
    'fixture',
    'default',
    { branch: 'DEV-KEYLESS-work', worktree: '/tmp/keyless-work' },
    context,
    d,
    {},
    {},
  )
  const row = (await taskFlowReadStore(d).stageByHandle('fixture', opened.cursor!.id))!
  const runRecordId = newRecordId()
  const run = d
    .query<{ number: number }, (string | number)[]>(
      `INSERT INTO run
        (record_id,number,started_at,agent,job,repo,project_record_id,prompt_sha,prompt_bytes,
         prompt_head,status,launch_key,task_record_id,session_id,cursor_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-18','codex','implement',
               'fixture',(SELECT record_id FROM project WHERE name='fixture'),'sha',1,'carried run',
               'running','DEV-KEYLESS','task-DEV-KEYLESS',?,?)
       RETURNING number`,
    )
    .get(runRecordId, context.session, row.record_id)!
  return { d, context, row, run: { recordId: runRecordId, number: run.number } }
}

const refusalArgs = {
  key: 'DEV-HANDOFF-REFUSAL',
  branch: 'DEV-HANDOFF-REFUSAL-work',
  worktree: '/tmp/work',
}
const refusalContext = {
  session: 'handoff-refusal-session',
  taskRecordId: 'task-DEV-HANDOFF-REFUSAL',
  taskStatusCategory: 'active',
}

async function refusalFixture(target = 'handoff-target') {
  const d = database()
  install(d, 'handoff-source', ['lens', 'score'])
  install(d, target, ['score'])
  const opened = await composeWorkflowWithCursor(
    'handoff-source',
    'fixture',
    'default',
    refusalArgs,
    refusalContext,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  const row = (await taskFlowReadStore(d).stageByHandle('fixture', cursor))!
  return { d, cursor, row }
}

function cursorSnapshot(d: ReturnType<typeof database>, recordId: string) {
  return d
    .query<{ state: string; ordinal: number; revision: number; closed: string }, [string]>(
      'SELECT state,ordinal,revision,closed FROM workflow_cursor WHERE record_id=?',
    )
    .get(recordId)!
}

async function expectRefusalUnchanged(
  fixture: Awaited<ReturnType<typeof refusalFixture>>,
  call: () => Promise<unknown>,
  fix: string,
  exact = false,
) {
  const before = cursorSnapshot(fixture.d, fixture.row.record_id)
  if (exact) {
    let message = ''
    try {
      await call()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe(fix)
  } else await expect(call()).rejects.toThrow(fix)
  expect(cursorSnapshot(fixture.d, fixture.row.record_id)).toEqual(before)
  expect(
    fixture.d
      .query<{ count: number }, [string]>(
        'SELECT count(*) AS count FROM workflow_cursor WHERE handed_off_from_record_id=?',
      )
      .get(fixture.row.record_id),
  ).toEqual({ count: 0 })
}

function handoffCall(
  fixture: Awaited<ReturnType<typeof refusalFixture>>,
  overrides: Partial<Parameters<typeof handoffWorkflow>[0]> = {},
) {
  return () =>
    handoffWorkflow({
      row: fixture.row,
      workflow: 'handoff-target',
      mode: 'default',
      args: refusalArgs,
      reason: 'ready',
      context: refusalContext,
      live: {},
      database: fixture.d,
      ...overrides,
    })
}

test('handoff refuses an unmet source floor before writing and succeeds with its evidence', async () => {
  const fixture = await refusalFixture()
  const remedy =
    'floor recorded-artifact is unmet; pass --artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | <KEY>/<n> | task:<KEY> | task:<KEY>#comment:<id> | note:<record-id|label> | run number or run id | probe:<id> | exec:<id> | review-read:<UUID> | attached-text:<UUID> | #<pull request number> | GitHub pull-request link | a commit SHA>'
  await expectRefusalUnchanged(fixture, handoffCall(fixture), remedy, true)

  const result = await handoffCall(fixture, {
    evidence: {
      artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
    },
  })()

  expect(await taskFlowReadStore(fixture.d).stageByHandle('fixture', result.cursor)).toMatchObject({
    handed_off_from_record_id: fixture.row.record_id,
    state: 'running',
  })
})

test('handoff closes the old stage, opens and links the successor, moves context, and renews the same claim', async () => {
  const d = database()
  install(d, 'handoff-source', ['lens', 'score', 'complete'])
  install(d, 'handoff-target', ['score'])
  const args = { key: 'DEV-HANDOFF', branch: 'DEV-HANDOFF-work', worktree: '/tmp/work' }
  const context = {
    session: 'handoff-session',
    taskRecordId: 'task-DEV-HANDOFF',
    taskStatusCategory: 'active',
  }
  const opened = await composeWorkflowWithCursor(
    'handoff-source',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const oldNumber = opened.cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(oldNumber)
  await selectAndNextWorkflowStep(
    'handoff-source',
    'fixture',
    'default',
    args,
    'first done',
    context,
    d,
    {},
    testPorts,
  )
  const old = (await taskFlowReadStore(d).stageByHandle('fixture', oldNumber))!
  const attachment = await attachWorkflowTextByHandle(
    oldNumber,
    'carried build context',
    context,
    d,
  )
  d.query(`INSERT INTO context_item
    (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
    VALUES (?,'cursor',?,'decision','fact','carry me','test',?,?)`).run(
    newRecordId(),
    old.record_id,
    old.created_at,
    old.created_at,
  )
  const claim = d
    .query<{ record_id: string; closed_at: string | null }, [string]>(
      'SELECT record_id FROM board_claim WHERE subject_value=? AND closed_at IS NULL',
    )
    .get('DEV-HANDOFF')
  const result = await handoffWorkflow({
    row: old,
    workflow: 'handoff-target',
    mode: 'default',
    args,
    reason: 'ready to ship',
    context,
    live: {},
    database: d,
  })
  const oldAfter = (await taskFlowReadStore(d).stageByHandle('fixture', oldNumber))!
  const next = (await taskFlowReadStore(d).stageByHandle('fixture', result.cursor))!
  expect(oldAfter.state).toBe('done')
  expect(
    (JSON.parse(oldAfter.closed) as Array<{ note: string }>).map((entry) => entry.note),
  ).toEqual([
    'first done',
    `handed off to handoff-target (cursor ${result.cursor}): ready to ship`,
    'not run: handed off',
  ])
  expect(next).toMatchObject({
    state: 'running',
    ordinal: 0,
    handed_off_from_record_id: old.record_id,
    session_id: context.session,
  })
  expect(
    resolveWorkflowCursorSuccessor(
      old.record_id,
      await taskFlowHandoffLinks(taskFlowReadStore(d), [next.record_id]),
    ),
  ).toBe(next.record_id)
  expect(d.query('SELECT holder_id FROM context_item WHERE slug=?').get('decision')).toEqual({
    holder_id: next.record_id,
  })
  expect(
    d
      .query('SELECT cursor_record_id FROM workflow_step_text WHERE record_id=?')
      .get(attachment.slice('attached-text:'.length)),
  ).toEqual({ cursor_record_id: next.record_id })
  await expect(
    resolveCarriedAttachments([{ label: 'spec', text: `dispatch ${attachment}` }], {
      readAttachment: (token) => showWorkflowText(token, d),
    }),
  ).resolves.toContain('carried build context')
  expect(
    d
      .query<{ record_id: string; closed_at: string | null }, [string]>(
        'SELECT record_id,closed_at FROM board_claim WHERE subject_value=?',
      )
      .get('DEV-HANDOFF'),
  ).toEqual({ record_id: claim!.record_id, closed_at: null })
})

test('keyless handoff takes the claim, adopts the key, and moves context to its successor', async () => {
  const fixture = await keylessFixture()
  const args = {
    key: 'DEV-KEYLESS',
    branch: 'DEV-KEYLESS-work',
    worktree: '/tmp/keyless-work',
  }
  const context = await resolveWorkflowCursorContext(
    'fixture',
    args,
    fixture.context,
    async () => ({
      key: 'DEV-KEYLESS',
      record_id: 'task-DEV-KEYLESS',
      project: 'fixture',
      status_category: 'active',
    }),
    fixture.row,
  )
  fixture.d
    .query(`INSERT INTO context_item
      (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
      VALUES (?,'cursor',?,'keyless-decision','fact','carry me','test',?,?)`)
    .run(newRecordId(), fixture.row.record_id, fixture.row.created_at, fixture.row.created_at)
  const takes: string[] = []
  const result = await handoffWorkflow({
    row: fixture.row,
    workflow: 'handoff-target',
    mode: 'default',
    args,
    reason: 'task identified',
    context,
    live: {},
    database: fixture.d,
    evidence: { artifacts: [await attachWorkflowFloorArtifact(fixture.row, context, fixture.d)] },
    taskClaimPorts: admissionEnforcingTaskClaimPorts(fixture.d, { takes }),
  })
  const successor = (await taskFlowReadStore(fixture.d).stageByHandle('fixture', result.cursor))!
  expect(successor).toMatchObject({
    workflow_key: 'DEV-KEYLESS',
    task_record_id: 'task-DEV-KEYLESS',
    handed_off_from_record_id: fixture.row.record_id,
  })
  expect(
    fixture.d
      .query<{ task_record_id: string | null }, [string]>(
        'SELECT task_record_id FROM task_flow WHERE record_id=?',
      )
      .get(successor.task_flow_record_id!),
  ).toEqual({ task_record_id: 'task-DEV-KEYLESS' })
  expect(
    fixture.d.query('SELECT holder_id FROM context_item WHERE slug=?').get('keyless-decision'),
  ).toEqual({ holder_id: successor.record_id })
  expect(takes).toContain('DEV-KEYLESS')
  const runBinding = fixture.d
    .query<{ cursor_record_id: string | null }, [string]>(
      'SELECT cursor_record_id FROM run WHERE record_id=?',
    )
    .get(fixture.run.recordId)!
  const links = await taskFlowHandoffLinks(taskFlowReadStore(fixture.d), [successor.record_id])
  expect(resolveWorkflowCursorSuccessor(runBinding.cursor_record_id, links)).toBe(
    successor.record_id,
  )
  expect(
    decideKeyedRunCursorAdmission({
      turn: 'continue',
      key: 'DEV-KEYLESS',
      project: 'fixture',
      bindingPresent:
        resolveWorkflowCursorSuccessor(runBinding.cursor_record_id, links) === successor.record_id,
      writesRepo: false,
      harnessSession: fixture.context.session,
      heldCursors: [],
      overrideReason: undefined,
      fromOperator: false,
    }),
  ).toEqual({ kind: 'allow' })
})

test('hosted admission fixture refuses a keyless stage and admits it once keyed', async () => {
  const fixture = await keylessFixture()
  const ports = admissionEnforcingTaskClaimPorts(fixture.d)
  const claim = {
    project: 'fixture',
    key: 'DEV-KEYLESS',
    session: fixture.context.session,
  }

  await expect(ports.take(claim)).rejects.toThrow(
    'fixture hosted admission: no running or awaiting-ruling stage keyed DEV-KEYLESS for session keyless-handoff-session',
  )

  await adoptWorkflowTask(fixture.row, claim.key, 'task-DEV-KEYLESS', fixture.d)

  await expect(ports.take(claim)).resolves.toMatchObject({ action: 'taken' })
})

test('brief lineage lists a carried run under the real handoff successor', async () => {
  const fixture = await keylessFixture()
  const args = {
    key: 'DEV-KEYLESS',
    branch: 'DEV-KEYLESS-work',
    worktree: '/tmp/keyless-work',
  }
  const context = await resolveWorkflowCursorContext(
    'fixture',
    args,
    fixture.context,
    async () => ({
      key: 'DEV-KEYLESS',
      record_id: 'task-DEV-KEYLESS',
      project: 'fixture',
      status_category: 'active',
    }),
    fixture.row,
  )
  const result = await handoffWorkflow({
    row: fixture.row,
    workflow: 'handoff-target',
    mode: 'default',
    args,
    reason: 'task identified',
    context,
    live: {},
    database: fixture.d,
    evidence: { artifacts: [await attachWorkflowFloorArtifact(fixture.row, context, fixture.d)] },
  })
  const successor = (await taskFlowReadStore(fixture.d).stageByHandle('fixture', result.cursor))!
  const selected = selectBriefInFlight(
    [
      {
        number: fixture.run.number,
        job: 'implement',
        status: 'running',
        label: 'carried run',
        cursor_record_id: fixture.row.record_id,
      },
    ],
    [successor],
    [],
    await workflowCursorHandoffLinks([successor], fixture.d),
  )

  expect(selected.runs).toEqual([])
  expect(selected.cursorRuns).toEqual([
    { recordId: successor.record_id, runs: [fixture.run.number] },
  ])
})

function failingKeylessHandoff(
  fixture: Awaited<ReturnType<typeof keylessFixture>>,
  claimAction: 'taken' | 'renewed' | 'taken-over',
  releases: string[],
  artifact: string,
) {
  return handoffWorkflow({
    row: fixture.row,
    workflow: 'handoff-target',
    mode: 'default',
    args: {
      key: 'DEV-KEYLESS',
      branch: 'DEV-KEYLESS-work',
      worktree: '/tmp/keyless-work',
    },
    reason: 'task identified',
    context: {
      ...fixture.context,
      taskRecordId: 'task-DEV-KEYLESS',
      taskStatusCategory: 'active',
    },
    live: {},
    database: fixture.d,
    evidence: { artifacts: [artifact] },
    taskClaimPorts: admissionEnforcingTaskClaimPorts(fixture.d, {
      action: claimAction,
      releases,
    }),
  })
}

test('keyless handoff failure before adoption reports that the cursor remains keyless', async () => {
  const fixture = await keylessFixture()
  fixture.d.exec(`CREATE TRIGGER fail_keyless_adoption
    BEFORE UPDATE OF workflow_key ON workflow_cursor
    BEGIN SELECT RAISE(ABORT, 'adoption exploded'); END`)

  const releases: string[] = []
  const artifact = await attachWorkflowFloorArtifact(fixture.row, fixture.context, fixture.d)
  await expect(failingKeylessHandoff(fixture, 'taken', releases, artifact)).rejects.toThrow(
    `adoption exploded; cursor ${fixture.row.id} remains keyless`,
  )
  expect(releases).toEqual([])
})

test('keyless handoff failure after adoption reports that the cursor is keyed', async () => {
  const fixture = await keylessFixture()
  fixture.d.exec(`CREATE TRIGGER fail_keyless_successor
    BEFORE INSERT ON workflow_cursor WHEN NEW.handed_off_from_record_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'successor exploded'); END`)

  const releases: string[] = []
  const artifact = await attachWorkflowFloorArtifact(fixture.row, fixture.context, fixture.d)
  let message = ''
  try {
    await failingKeylessHandoff(fixture, 'taken-over', releases, artifact)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).toContain(
    `successor exploded; cursor ${fixture.row.id} is now keyed to DEV-KEYLESS`,
  )
  expect(message).toContain(
    `retry with workflow handoff handoff-target --mode default --cursor ${fixture.row.id} --project fixture --reason 'task identified' --arg key=DEV-KEYLESS --arg branch=DEV-KEYLESS-work --arg worktree=/tmp/keyless-work`,
  )
  expect(releases).toEqual(['DEV-KEYLESS'])
})

test('a post-adoption open-stage refusal points at workflow cursors', async () => {
  const fixture = await keylessFixture()
  fixture.d.exec(`CREATE TRIGGER detach_keyless_open_stage
    AFTER UPDATE OF workflow_key ON workflow_cursor
    BEGIN UPDATE task_flow SET open_stage_cursor_record_id=NULL WHERE record_id=NEW.task_flow_record_id; END`)

  const artifact = await attachWorkflowFloorArtifact(fixture.row, fixture.context, fixture.d)
  await expect(failingKeylessHandoff(fixture, 'taken', [], artifact)).rejects.toThrow(
    `retry with workflow cursors --project fixture`,
  )
})

test('keyless handoff failure preserves a claim renewed from this session', async () => {
  const fixture = await keylessFixture()
  fixture.d.exec(`CREATE TRIGGER fail_renewed_keyless_successor
    BEFORE INSERT ON workflow_cursor WHEN NEW.handed_off_from_record_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'successor exploded'); END`)
  const releases: string[] = []
  const artifact = await attachWorkflowFloorArtifact(fixture.row, fixture.context, fixture.d)

  let message = ''
  try {
    await failingKeylessHandoff(fixture, 'renewed', releases, artifact)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).toContain(
    `successor exploded; cursor ${fixture.row.id} is now keyed to DEV-KEYLESS`,
  )
  expect(message).toContain(
    `retry with workflow handoff handoff-target --mode default --cursor ${fixture.row.id} --project fixture --reason 'task identified' --arg key=DEV-KEYLESS --arg branch=DEV-KEYLESS-work --arg worktree=/tmp/keyless-work`,
  )
  expect(releases).toEqual([])
})

test('a refused keyless claim reports that the source cursor is now keyed and names the holder', async () => {
  const fixture = await keylessFixture()
  await expect(
    handoffWorkflow({
      row: fixture.row,
      workflow: 'handoff-target',
      mode: 'default',
      args: {
        key: 'DEV-HELD',
        branch: 'DEV-HELD-work',
        worktree: '/tmp/keyless-work',
      },
      reason: 'task identified',
      context: { ...fixture.context, taskRecordId: 'task-DEV-HELD' },
      live: {},
      database: fixture.d,
      evidence: {
        artifacts: [await attachWorkflowFloorArtifact(fixture.row, fixture.context, fixture.d)],
      },
      taskClaimPorts: {
        take: async () => {
          throw new Error('claim conflicts with: session holder-session')
        },
        release: async () => ({ released: 0 }),
      },
    }),
  ).rejects.toThrow(
    `session holder-session; cursor ${fixture.row.id} is now keyed to DEV-HELD; retry with`,
  )
  expect(await taskFlowReadStore(fixture.d).stageByRecordId(fixture.row.record_id)).toMatchObject({
    workflow_key: 'DEV-HELD',
    state: 'running',
  })
})

test('keyless handoff without a target key gives the key remedy', async () => {
  const fixture = await keylessFixture()
  await expect(
    handoffWorkflow({
      row: fixture.row,
      workflow: 'handoff-keyless-source',
      mode: 'default',
      args: { branch: 'DEV-KEYLESS-work', worktree: '/tmp/keyless-work' },
      reason: 'task identified',
      context: fixture.context,
      live: {},
      database: fixture.d,
      evidence: {
        artifacts: [await attachWorkflowFloorArtifact(fixture.row, fixture.context, fixture.d)],
      },
    }),
  ).rejects.toThrow('pass --arg key=<KEY>')
})

test('keyed handoff defaults the target key to the source key', async () => {
  const fixture = await refusalFixture()
  const result = await handoffCall(fixture, {
    args: { branch: refusalArgs.branch, worktree: refusalArgs.worktree },
    evidence: {
      artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
    },
  })()
  expect(await taskFlowReadStore(fixture.d).stageByHandle('fixture', result.cursor)).toMatchObject({
    workflow_key: refusalArgs.key,
  })
})

test('handoff refuses an unknown workflow without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { workflow: 'missing-handoff-target', evidence }),
    'workflow "missing-handoff-target" has no production version; promote one',
  )
})

test('handoff refuses a missing required argument without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { args: { key: refusalArgs.key }, evidence }),
    'workflow "handoff-target" needs arguments: branch, worktree; pass each with --arg k=v',
    true,
  )
})

test('handoff refuses a mode the target workflow does not define without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { mode: 'missing-mode', evidence }),
    'workflow "handoff-target" has no mode "missing-mode"',
  )
})

test('handoff refuses ship-task with an empty branch without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture('ship-task')
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { workflow: 'ship-task', commitCount: () => 0, evidence }),
    `build the change first with \`${PLATFORM_SLUG} run start implement --key <key>\``,
  )
})

test('handoff refuses a different key without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { args: { ...refusalArgs, key: 'DEV-OTHER' }, evidence }),
    `pass --arg key=${refusalArgs.key}`,
  )
})

test('handoff refuses a cursor awaiting a ruling without changing it or opening a successor', async () => {
  const fixture = await refusalFixture()
  fixture.d
    .query(
      "UPDATE workflow_cursor SET state='awaiting-ruling',question='Proceed?' WHERE record_id=?",
    )
    .run(fixture.row.record_id)
  fixture.row = (await taskFlowReadStore(fixture.d).stageByHandle('fixture', fixture.cursor))!
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture),
    'answer its question, then retry the handoff',
  )
})

test('handoff refuses a cursor with an open workflow question without changing it or opening a successor', async () => {
  const fixture = await refusalFixture()
  await awaitWorkflowRuling(
    'handoff-source',
    'fixture',
    'default',
    refusalArgs,
    'Which way?',
    refusalContext,
    fixture.d,
    () => {},
  )
  fixture.row = (await taskFlowReadStore(fixture.d).stageByHandle('fixture', fixture.cursor))!
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture),
    'answer its question, then retry the handoff',
  )
})

test("handoff refuses another session's cursor without changing it or opening a successor", async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, {
      context: { ...refusalContext, session: 'another-session' },
    }),
    `hand off it from that session`,
  )
})

test('handoff refuses a missing reason without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { reason: '  ' }),
    'pass --reason "<why>"',
  )
})

test('handoff refuses a stale revision without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  fixture.d
    .query('UPDATE workflow_cursor SET revision=revision+1 WHERE record_id=?')
    .run(fixture.row.record_id)
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { evidence }),
    'changed while being handed off; rerun the command',
  )
})

test("handoff refuses a cursor that is not the task flow's open stage without changing it or opening a successor", async () => {
  const fixture = await refusalFixture()
  const evidence = {
    artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
  }
  fixture.d
    .query('UPDATE task_flow SET open_stage_cursor_record_id=NULL WHERE record_id=?')
    .run(fixture.row.task_flow_record_id!)
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { evidence }),
    "is not the task flow's open stage; list workflow cursors and retry the current cursor",
  )
})

test('handoff commits and reports a warning when its claim cannot be renewed', async () => {
  const fixture = await refusalFixture()
  const result = await handoffCall(fixture, {
    evidence: {
      artifacts: [await attachWorkflowFloorArtifact(fixture.row, refusalContext, fixture.d)],
    },
    taskClaimPorts: {
      take: async () => {
        throw new Error('claim service unavailable')
      },
      release: async () => ({ released: 0 }),
    },
  })()
  expect(result).toMatchObject({
    workflow: 'handoff-target',
    claimWarning: expect.stringContaining('claim service unavailable'),
  })
  expect(
    fixture.d
      .query<{ state: string }, [string]>('SELECT state FROM workflow_cursor WHERE record_id=?')
      .get(fixture.row.record_id),
  ).toEqual({ state: 'done' })
})
