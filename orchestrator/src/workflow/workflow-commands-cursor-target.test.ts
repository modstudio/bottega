import { expect, test } from 'bun:test'
import { db, sessionId } from '../database/db.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerFixtureWorkflowProject as registerFixtureProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('cursor verbs parse every documented positional form before flags', async () => {
  const slug = 'cursor-command-positionals'
  const project = 'cursor-command-positionals-project'
  const key = 'DEV-1880-fixture'
  const catalogue = productionStepCatalogue().definition.steps
  const currentStep = catalogue.find(({ slug }) => slug === 'blast-radius')!.slug
  const nextStep = catalogue.find(({ slug }) => slug === 'fix-defect-triage')!.slug
  const steps = [currentStep, nextStep]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [{ slug: 'default', title: 'Default', default: true, steps }])
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'workflow-command-positionals'
  try {
    const opened = composeWorkflowWithCursor(
      slug,
      project,
      'default',
      { key },
      { session: sessionId() },
      undefined,
      {},
      {},
    )
    const openedCursor = opened.cursor!.id
    const stored = db()
      .query<{ record_id: string }, [number]>(
        'SELECT record_id FROM workflow_cursor WHERE number=?',
      )
      .get(openedCursor)!
    const cursor = 950
    db()
      .query('UPDATE workflow_cursor SET number=? WHERE record_id=?')
      .run(cursor, stored.record_id)
    const rows = [
      { verb: 'step', argv: ['--cursor', String(cursor)], result: 'step' },
      { verb: 'step', argv: [slug, '--cursor', String(cursor)], result: 'step' },
      { verb: 'step', argv: ['--cursor', String(cursor), currentStep], result: 'step' },
      { verb: 'step', argv: [slug, currentStep, '--cursor', String(cursor)], result: 'step' },
      {
        verb: 'step',
        argv: [slug, currentStep, '--project', project, '--arg', `key=${key}`],
        result: 'step',
      },
      {
        verb: 'next',
        argv: ['--cursor', String(cursor), '--note', 'fixture complete'],
        result: 'next',
      },
      {
        verb: 'next',
        argv: [slug, '--cursor', String(cursor), '--note', 'fixture complete'],
        result: 'next',
      },
      {
        verb: 'await',
        argv: ['--cursor', String(cursor), '--question', 'What is the ruling?'],
        result: 'await',
      },
      {
        verb: 'await',
        argv: [slug, '--cursor', String(cursor), '--question', 'What is the ruling?'],
        result: 'await',
      },
      { verb: 'attach', argv: ['--cursor', String(cursor)], result: 'attach' },
      { verb: 'attach', argv: [slug, '--cursor', String(cursor)], result: 'attach' },
    ] as const

    const failures: string[] = []
    for (const row of rows) {
      db()
        .query(
          "UPDATE workflow_cursor SET ordinal=0,step_slug=?,state='running',closed='[]',question=NULL,enforcement='note-only' WHERE number=?",
        )
        .run(currentStep, cursor)
      db().query('DELETE FROM workflow_step_text WHERE cursor_record_id=?').run(stored.record_id)
      const lines: string[] = []
      try {
        await workflowCommand(['workflow', row.verb, ...row.argv], presentation(lines), {
          json: true,
          stdinIsTTY: () => false,
          stdinText: async () => 'fixture workflow text',
        })
        if (row.result === 'step') {
          expect((JSON.parse(lines[0]!) as { slug: string }).slug).toBe(currentStep)
        } else if (row.result === 'attach') {
          expect(
            db().query('SELECT cursor_record_id,step_slug FROM workflow_step_text').get(),
          ).toEqual({ cursor_record_id: stored.record_id, step_slug: currentStep })
        } else {
          expect(
            db()
              .query('SELECT workflow_slug,state,ordinal FROM workflow_cursor WHERE number=?')
              .get(cursor),
          ).toEqual({
            workflow_slug: slug,
            state: row.result === 'next' ? 'running' : 'awaiting-ruling',
            ordinal: row.result === 'next' ? 1 : 0,
          })
        }
      } catch (error) {
        failures.push(`${row.verb} ${row.argv.join(' ')}: ${String(error)}`)
      }
    }
    expect(failures).toEqual([])
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})
