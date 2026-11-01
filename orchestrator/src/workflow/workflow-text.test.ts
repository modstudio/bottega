import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import {
  abandonWorkflowCursor,
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
  workflowTextIdsToDelete,
} from './workflow-text.ts'
import {
  closeCursorWithTextCopy,
  copyWorkflowTextForCursor,
  cursorForWorkflowTextCopy,
  showWorkflowText,
  type WorkflowTaskDocument,
  type WorkflowTextDocumentPorts,
  workflowTextUncopiedReport,
} from './workflow-text-copy.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const context = { session: 'text-owner' }

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      tracker: { protocol: 'hub' },
      docs: { protocol: 'orch-docs' },
    }),
  )
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
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
  promoteStepCatalogueLocal(catalogue.n, 'publish fixture', 'test', d)
  const workflow = setWorkflowLocal(
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
  promoteWorkflowLocal('text-fixture', workflow.n, 'publish fixture', 'test', d)
})

function open(d: Database): number {
  return getWorkflowStepWithCursor(
    'text-fixture',
    'fixture',
    'text-source',
    {},
    'default',
    context,
    d,
    {},
  ).cursor
}

const abandon = (d: Database, cursor: number, reason: string) =>
  abandonWorkflowCursor('text-fixture', 'fixture', 'default', {}, reason, context, d, cursor)

const rowCount = (d: Database, cursor: number) =>
  (
    d
      .query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count FROM workflow_step_text
          WHERE cursor_record_id=(SELECT record_id FROM workflow_cursor WHERE number=?)`,
      )
      .get(cursor) as { count: number }
  ).count

describe('workflow text decisions', () => {
  test('linked deletion selects only copied rows while unlinked deletion selects every row', () => {
    const cases = [
      { linked: false, copied: [], expected: ['one', 'two'] },
      { linked: true, copied: [], expected: [] },
      { linked: true, copied: ['two'], expected: ['two'] },
      { linked: true, copied: ['one', 'two'], expected: ['one', 'two'] },
    ]
    for (const entry of cases)
      expect(
        workflowTextIdsToDelete({
          linked: entry.linked,
          rowIds: ['one', 'two'],
          copiedIds: new Set(entry.copied),
        }),
      ).toEqual(entry.expected)
  })

  test('attach permission names both measured byte bounds and ownership', () => {
    expect(
      decideWorkflowTextAttach({
        state: 'running',
        ownerSession: 'owner',
        callerSession: 'other',
        attachmentBytes: 1,
        cursorBytes: 0,
      }),
    ).toMatchObject({
      action: 'refuse',
      message: expect.stringContaining('another session'),
    })
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
      id: 'attachment-9',
      cursorId: 'cursor-3',
      stepOrdinal: 2,
      stepSlug: 'research',
      body: 'notes',
    }
    expect(
      attachedTextReferenceMeetsFloor({
        cursorId: 'cursor-3',
        stepOrdinal: 2,
        stepSlug: 'research',
        attachment,
      }),
    ).toBe(true)
    expect(
      attachedTextReferenceMeetsFloor({
        cursorId: 'cursor-4',
        stepOrdinal: 2,
        stepSlug: 'research',
        attachment,
      }),
    ).toBe(false)
    expect(
      attachedTextReferenceMeetsFloor({
        cursorId: 'cursor-3',
        stepOrdinal: 3,
        stepSlug: 'design',
        attachment,
      }),
    ).toBe(false)
  })

  test('facts carry all text only for the declared cursor-local need, ordered by step and id', () => {
    const rows = [
      {
        id: 'attachment-4',
        cursorId: 'cursor-1',
        stepOrdinal: 2,
        stepSlug: 'decompose',
        body: 'breakdown',
      },
      {
        id: 'attachment-2',
        cursorId: 'cursor-1',
        stepOrdinal: 1,
        stepSlug: 'research',
        body: 'research',
      },
      {
        id: 'attachment-3',
        cursorId: 'cursor-1',
        stepOrdinal: 2,
        stepSlug: 'decompose',
        body: 'constraints',
      },
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
    expect(
      d.query<{ record_id: string }, []>('SELECT record_id FROM workflow_step_text').get()
        ?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
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
        .query<{ closed: string }, [number]>('SELECT closed FROM workflow_cursor WHERE number=?')
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
        .query<{ state: string }, [number]>('SELECT state FROM workflow_cursor WHERE number=?')
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
    const abandonedReference = attachWorkflowTextByHandle(
      abandonedCursor,
      'discard me',
      context,
      abandoned,
    )
    abandon(abandoned, abandonedCursor, 'no longer needed')
    expect(rowCount(abandoned, abandonedCursor)).toBe(0)
    expect(() => showWorkflowText(abandonedReference, abandoned)).toThrow(
      `${abandonedReference} is not held on this machine; attachments of a cursor not linked to a task are removed when the cursor closes, and an id from another machine is readable only through its task document`,
    )
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

const taskReader = async () => [{ key: 'DEV-1975', record_id: 'task-dev-1975', project: 'fixture' }]

function linkCursor(d: Database, cursor: number): void {
  d.query('UPDATE workflow_cursor SET task_record_id=? WHERE number=?').run('task-dev-1975', cursor)
}

function documentFake(initial: WorkflowTaskDocument[] = []): {
  ports: WorkflowTextDocumentPorts
  created: { title: string; body: string; reference: string }[]
} {
  const documents = [...initial]
  const created: { title: string; body: string; reference: string }[] = []
  return {
    created,
    ports: {
      async list() {
        return documents
      },
      async create(_task, _project, title, body) {
        const reference = `DEV-1975/${documents.length + 1}`
        documents.push({ reference, title })
        created.push({ title, body, reference })
        return reference
      },
    },
  }
}

describe('task-linked workflow text preservation', () => {
  test('the close service copies through a context-only task link and leaves a redirect', async () => {
    const d = database()
    const cursor = open(d)
    d.query("UPDATE workflow_cursor SET workflow_key='DEV-1975',args=? WHERE number=?").run(
      JSON.stringify({ key: 'DEV-1975' }),
      cursor,
    )
    const reference = attachWorkflowTextByHandle(cursor, 'context-linked body', context, d)
    const fake = documentFake()
    await closeCursorWithTextCopy(
      {
        action: 'abandon',
        project: 'fixture',
        workflow: 'text-fixture',
        mode: 'default',
        key: 'DEV-1975',
        cursor,
        args: { key: 'DEV-1975' },
        context: { ...context, taskRecordId: 'task-dev-1975' },
        reason: 'copied before close',
      },
      d,
      taskReader,
      fake.ports,
    )
    expect(fake.created).toHaveLength(1)
    expect(
      d.query<{ count: number }, []>('SELECT COUNT(*) count FROM workflow_text_copy').get()?.count,
    ).toBe(1)
    expect(showWorkflowText(reference, d)).toMatchObject({
      kind: 'redirect',
      documentReference: 'DEV-1975/1',
    })
  })

  test('refused close validation makes no document-port call', async () => {
    let calls = 0
    const documents: WorkflowTextDocumentPorts = {
      async list() {
        calls += 1
        return []
      },
      async create() {
        calls += 1
        return 'DEV-1975/1'
      },
    }
    const nextDb = database()
    const nextCursor = open(nextDb)
    linkCursor(nextDb, nextCursor)
    attachWorkflowTextByHandle(nextCursor, 'must not copy', context, nextDb)
    await expect(
      closeCursorWithTextCopy(
        {
          action: 'next',
          project: 'fixture',
          workflow: 'text-fixture',
          mode: 'default',
          cursor: nextCursor,
          args: {},
          context,
        },
        nextDb,
        taskReader,
        documents,
      ),
    ).rejects.toThrow('--note is required')

    const terminalDb = database()
    const terminalCursor = open(terminalDb)
    linkCursor(terminalDb, terminalCursor)
    attachWorkflowTextByHandle(terminalCursor, 'terminal text', context, terminalDb)
    abandon(terminalDb, terminalCursor, 'first close')
    await expect(
      closeCursorWithTextCopy(
        {
          action: 'abandon',
          cursor: terminalCursor,
          args: {},
          context,
          reason: 'refused repeat',
        },
        terminalDb,
        taskReader,
        documents,
      ),
    ).rejects.toThrow('is abandoned')
    expect(calls).toBe(0)
  })

  test('finish and abandon preserve every attachment as a readable document redirect', async () => {
    for (const terminal of ['finish', 'abandon'] as const) {
      const d = database()
      const cursor = open(d)
      linkCursor(d, cursor)
      const fake = documentFake()
      const references: string[] = []
      if (terminal === 'finish') {
        for (const note of ['source', 'consumer', 'final']) {
          const reference = attachWorkflowTextByHandle(cursor, `${terminal} ${note}`, context, d)
          references.push(reference)
          await copyWorkflowTextForCursor(
            cursorForWorkflowTextCopy(cursor, d),
            d,
            taskReader,
            fake.ports,
          )
          nextWorkflowStep(
            'text-fixture',
            'fixture',
            'default',
            {},
            note,
            context,
            d,
            { artifact: reference },
            {},
            cursor,
          )
        }
      } else {
        references.push(
          attachWorkflowTextByHandle(cursor, `${terminal} first`, context, d),
          attachWorkflowTextByHandle(cursor, `${terminal} second`, context, d),
        )
        await copyWorkflowTextForCursor(
          cursorForWorkflowTextCopy(cursor, d),
          d,
          taskReader,
          fake.ports,
        )
        abandon(d, cursor, 'done')
      }
      for (const reference of references) {
        const shown = showWorkflowText(reference, d)
        expect(shown.kind).toBe('redirect')
      }
      expect(fake.created.map((row) => row.body)).toEqual(
        terminal === 'finish'
          ? ['finish source', 'finish consumer', 'finish final']
          : ['abandon first', 'abandon second'],
      )
    }
  })

  test('a failed copy does not block close, and terminal retry copies then deletes the live row', async () => {
    const d = database()
    const cursor = open(d)
    linkCursor(d, cursor)
    const reference = attachWorkflowTextByHandle(cursor, 'survives failure', context, d)
    const failing = documentFake()
    failing.ports.create = async () => {
      throw new Error('document service unavailable')
    }
    const failed = await copyWorkflowTextForCursor(
      cursorForWorkflowTextCopy(cursor, d),
      d,
      taskReader,
      failing.ports,
    )
    expect(failed.uncopied).toHaveLength(1)
    abandon(d, cursor, 'close anyway')
    expect(workflowTextUncopiedReport(failed)).toContain('workflow text copy --cursor')
    expect(showWorkflowText(reference, d)).toMatchObject({ kind: 'live', body: 'survives failure' })

    const retry = documentFake()
    await copyWorkflowTextForCursor(
      cursorForWorkflowTextCopy(cursor, d),
      d,
      taskReader,
      retry.ports,
    )
    expect(rowCount(d, cursor)).toBe(0)
    expect(showWorkflowText(reference, d)).toMatchObject({
      kind: 'redirect',
      documentReference: 'DEV-1975/1',
    })
  })

  test('retry reuses only an exact first title token, never a prefix collision', async () => {
    const exactDb = database()
    const exactCursor = open(exactDb)
    linkCursor(exactDb, exactCursor)
    const exactReference = attachWorkflowTextByHandle(exactCursor, 'exact', context, exactDb)
    const exactId = exactReference.slice('attached-text:'.length)
    const exact = documentFake([
      { reference: 'DEV-1975/7', title: `attached-text:${exactId} original-step` },
    ])
    const exactResult = await copyWorkflowTextForCursor(
      cursorForWorkflowTextCopy(exactCursor, exactDb),
      exactDb,
      taskReader,
      exact.ports,
    )
    expect(exactResult.copied).toEqual([
      { id: exactId, documentReference: 'DEV-1975/7', reused: true },
    ])
    expect(exact.created).toHaveLength(0)

    const prefixDb = database()
    const prefixCursor = open(prefixDb)
    linkCursor(prefixDb, prefixCursor)
    const prefixReference = attachWorkflowTextByHandle(prefixCursor, 'prefix', context, prefixDb)
    const prefixId = prefixReference.slice('attached-text:'.length)
    const prefix = documentFake([
      { reference: 'DEV-1975/8', title: `attached-text:${prefixId}x collision` },
    ])
    const prefixResult = await copyWorkflowTextForCursor(
      cursorForWorkflowTextCopy(prefixCursor, prefixDb),
      prefixDb,
      taskReader,
      prefix.ports,
    )
    expect(prefixResult.copied[0]).toMatchObject({ reused: false })
    expect(prefix.created[0]?.title).toBe(`attached-text:${prefixId} text-source`)
  })
})
