import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import {
  abandonWorkflowCursorByHandle,
  getWorkflowStepWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import {
  attachedTextReferenceMeetsFloor,
  attachWorkflowTextByHandle,
  decideWorkflowTextAttach,
  WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES,
  WORKFLOW_TEXT_CURSOR_MAX_BYTES,
  workflowTextFacts,
} from './workflow-text.ts'
import { promoteWorkflow, setWorkflow } from './workflows.ts'

const context = { session: 'text-owner' }

function database(): Database {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ tracker: { protocol: 'hub' }, docs: { protocol: 'orch-docs' } }),
  )
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogue(
    {
      steps: [
        ...current.steps,
        ...['source', 'consumer', 'final'].map((slug) => ({
          slug: `text-${slug}`,
          title: `Text ${slug}`,
          body: `Text ${slug}.`,
          floor: ['recorded-artifact'],
          job: null,
          stage: 'plan',
          autonomy: 'auto',
          needs: slug === 'consumer' ? ['workflow-text'] : [],
        })),
      ],
    },
    'text attachment fixture',
    'test',
    d,
  )
  promoteStepCatalogue(catalogue.n, 'publish fixture', 'test', d)
  const workflow = setWorkflow(
    'text-fixture',
    {
      title: 'Text fixture',
      description: 'Exercises workflow text.',
      arguments: [],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['text-source', 'text-consumer', 'text-final'],
        },
      ],
    },
    'text attachment fixture',
    'test',
    d,
  )
  promoteWorkflow('text-fixture', workflow.n, 'publish fixture', 'test', d)
  return d
}

function open(d: Database): number {
  return getWorkflowStepWithCursor(
    'text-fixture',
    'fixture',
    'text-source',
    {},
    'default',
    context,
    d,
  ).cursor
}

const rowCount = (d: Database, cursor: number) =>
  (
    d
      .query<{ count: number }, [number]>(
        'SELECT COUNT(*) AS count FROM workflow_step_text WHERE cursor_id=?',
      )
      .get(cursor) as { count: number }
  ).count

describe('workflow text decisions', () => {
  test('attach permission names both measured byte bounds and ownership', () => {
    expect(
      decideWorkflowTextAttach({
        state: 'running',
        ownerSession: 'owner',
        callerSession: 'other',
        attachmentBytes: 1,
        cursorBytes: 0,
      }),
    ).toMatchObject({ action: 'refuse', message: expect.stringContaining('another session') })
    expect(
      decideWorkflowTextAttach({
        state: 'running',
        ownerSession: 'owner',
        callerSession: 'owner',
        attachmentBytes: WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES + 1,
        cursorBytes: 0,
      }),
    ).toEqual({
      action: 'refuse',
      message:
        `WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES is ${WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES} bytes; ` +
        `the attachment is ${WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES + 1} bytes; shorten the text and attach it again`,
    })
    expect(
      decideWorkflowTextAttach({
        state: 'running',
        ownerSession: 'owner',
        callerSession: 'owner',
        attachmentBytes: 1,
        cursorBytes: WORKFLOW_TEXT_CURSOR_MAX_BYTES,
      }),
    ).toMatchObject({
      action: 'refuse',
      message: expect.stringContaining(
        `the cursor would hold ${WORKFLOW_TEXT_CURSOR_MAX_BYTES + 1} bytes`,
      ),
    })
  })

  test('an attached-text reference is bound to its cursor and exact step', () => {
    const attachment = {
      id: 9,
      cursorId: 3,
      stepOrdinal: 2,
      stepSlug: 'research',
      body: 'notes',
    }
    expect(
      attachedTextReferenceMeetsFloor({
        cursorId: 3,
        stepOrdinal: 2,
        stepSlug: 'research',
        attachment,
      }),
    ).toBe(true)
    expect(
      attachedTextReferenceMeetsFloor({
        cursorId: 4,
        stepOrdinal: 2,
        stepSlug: 'research',
        attachment,
      }),
    ).toBe(false)
    expect(
      attachedTextReferenceMeetsFloor({
        cursorId: 3,
        stepOrdinal: 3,
        stepSlug: 'design',
        attachment,
      }),
    ).toBe(false)
  })

  test('facts carry all text only for the declared cursor-local need, ordered by step and id', () => {
    const rows = [
      { id: 4, cursorId: 1, stepOrdinal: 2, stepSlug: 'decompose', body: 'breakdown' },
      { id: 2, cursorId: 1, stepOrdinal: 1, stepSlug: 'research', body: 'research' },
      { id: 3, cursorId: 1, stepOrdinal: 2, stepSlug: 'decompose', body: 'constraints' },
    ]
    expect(workflowTextFacts([], rows)).toEqual({})
    expect(workflowTextFacts(['workflow-text'], rows)).toEqual({
      workflowText: [
        { stepSlug: 'research', body: 'research' },
        { stepSlug: 'decompose', body: 'constraints' },
        { stepSlug: 'decompose', body: 'breakdown' },
      ],
    })
  })
})

describe('workflow text lifecycle', () => {
  test('attach then close meets the floor, injects text, and stores only a marker in the trail', () => {
    const d = database()
    const cursor = open(d)
    const reference = attachWorkflowTextByHandle(cursor, 'research body', context, d)
    const rendered = nextWorkflowStep(
      'text-fixture',
      'fixture',
      'default',
      {},
      'research attached',
      context,
      d,
      { artifact: reference },
      {},
      cursor,
    )
    expect(rendered).toContain('"workflowText"')
    expect(rendered).toContain('research body')
    const closed = (
      d
        .query<{ closed: string }, [number]>('SELECT closed FROM workflow_cursor WHERE id=?')
        .get(cursor) as { closed: string }
    ).closed
    expect(closed).toContain('attached-text')
    expect(closed).not.toContain(reference)
    expect(closed).not.toContain('research body')
  })

  test('closing a workflow-text step deletes every attachment while the cursor stays live', () => {
    const d = database()
    const cursor = open(d)
    const source = attachWorkflowTextByHandle(cursor, 'source', context, d)
    nextWorkflowStep(
      'text-fixture',
      'fixture',
      'default',
      {},
      'source attached',
      context,
      d,
      { artifact: source },
      {},
      cursor,
    )
    const consumer = attachWorkflowTextByHandle(cursor, 'consumer copy', context, d)
    nextWorkflowStep(
      'text-fixture',
      'fixture',
      'default',
      {},
      'task written',
      context,
      d,
      { artifact: consumer },
      {},
      cursor,
    )
    expect(rowCount(d, cursor)).toBe(0)
    expect(
      d
        .query<{ state: string }, [number]>('SELECT state FROM workflow_cursor WHERE id=?')
        .get(cursor)?.state,
    ).toBe('running')
  })

  test('finish and abandon each remove cursor text', () => {
    const finished = database()
    const finishedCursor = open(finished)
    for (const note of ['source', 'consumer', 'final']) {
      const reference = attachWorkflowTextByHandle(finishedCursor, note, context, finished)
      nextWorkflowStep(
        'text-fixture',
        'fixture',
        'default',
        {},
        note,
        context,
        finished,
        { artifact: reference },
        {},
        finishedCursor,
      )
    }
    expect(rowCount(finished, finishedCursor)).toBe(0)

    const abandoned = database()
    const abandonedCursor = open(abandoned)
    attachWorkflowTextByHandle(abandonedCursor, 'discard me', context, abandoned)
    abandonWorkflowCursorByHandle(abandonedCursor, 'no longer needed', context, abandoned)
    expect(rowCount(abandoned, abandonedCursor)).toBe(0)
  })

  test('the service refuses text over either live byte bound', () => {
    const d = database()
    const cursor = open(d)
    expect(() =>
      attachWorkflowTextByHandle(
        cursor,
        'x'.repeat(WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES + 1),
        context,
        d,
      ),
    ).toThrow('WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES')
    attachWorkflowTextByHandle(cursor, 'x'.repeat(WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES), context, d)
    attachWorkflowTextByHandle(cursor, 'y'.repeat(WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES), context, d)
    expect(() => attachWorkflowTextByHandle(cursor, 'z', context, d)).toThrow(
      'WORKFLOW_TEXT_CURSOR_MAX_BYTES',
    )
  })
})
