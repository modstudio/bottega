import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { getDoc, setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { type FileRulingInput, fileRuling, type RulingFileStores } from './ruling-file.ts'

let priorSession: string | undefined
let priorDepth: string | undefined

beforeEach(() => {
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  priorDepth = process.env.ORCH_DEPTH
  process.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
  delete process.env.ORCH_DEPTH
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  if (priorDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorDepth
})

function addAnsweredQuestion(
  runId: number,
  question = 'Which shape?',
  extras: {
    answer?: string
    answererKind?: string
    answeredBy?: string
    overturned?: { reason: string; replacement: string | null }
    launchKey?: string
  } = {},
): number {
  const id = (
    db()
      .query(
        `INSERT INTO question
          (run_id,asked_at,question,answer,answered_at,answered_by,answerer_kind,answer_channel)
         VALUES (?,'2026-09-20',?,?, '2026-09-21',?,?, 'cli')
         RETURNING id`,
      )
      .get(
        runId,
        question,
        extras.answer ?? 'Keep the existing one.',
        extras.answeredBy ?? 'operator via owner-session',
        extras.answererKind ?? 'operator',
      ) as { id: number }
  ).id
  if (extras.overturned) {
    db()
      .query(
        `UPDATE question
            SET overturned_at='2026-09-22', overturned_by='operator via owner-session',
                overturn_reason=?, replacement=?
          WHERE id=?`,
      )
      .run(extras.overturned.reason, extras.overturned.replacement, id)
  }
  if (extras.launchKey)
    db().query('UPDATE run SET launch_key=? WHERE id=?').run(extras.launchKey, runId)
  return id
}

const stores = (overrides: Partial<RulingFileStores> = {}): RulingFileStores => ({
  writeDoc: async () => ({ id: 12, revision: 'rev-1' }),
  fileNote: async () => ({ output: 'note 44 filed; 1 sighting' }),
  ...overrides,
})

const file = (
  input: Omit<FileRulingInput, 'fromOperator' | 'channel'> &
    Partial<Pick<FileRulingInput, 'fromOperator' | 'channel' | 'dashboardAuthorized'>>,
  filingStores: RulingFileStores = stores(),
) => fileRuling({ fromOperator: false, channel: 'cli', ...input }, filingStores)

describe('file ruling', () => {
  test('files a workflow ruling with workflow provenance and question audit', async () => {
    db()
      .query(
        `INSERT OR IGNORE INTO project (name,path,canon,settings)
       VALUES ('workflow-fixture','/fixture',1,'{}')`,
      )
      .run()
    const cursor = db()
      .query(
        `INSERT INTO workflow_cursor
          (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('workflow-fixture','ship','default','DEV-964','','owner-session',1,1,'{}',0,
                 'build','running','[]',NULL,1,'2026-09-20','2026-09-21') RETURNING id`,
      )
      .get() as { id: number }
    const question = db()
      .query(
        `INSERT INTO question
          (workflow_cursor_id,workflow_key,asked_at,question,answer,answered_at,answered_by,
           answerer_kind,answer_channel,asked_via)
         VALUES (?,'DEV-964','2026-09-20','Proceed?','Yes.','2026-09-21','owner-session',
                 'agent','cli','workflow') RETURNING id`,
      )
      .get(cursor.id) as { id: number }
    const writes: Array<{ subject: string | null; body: string }> = []

    await file(
      { questionId: question.id, as: 'doc' },
      stores({
        writeDoc: async (input) => {
          writes.push({ subject: input.subject, body: input.body })
          return { id: 88, revision: null }
        },
      }),
    )

    expect(writes[0]?.subject).toBe('workflow-fixture')
    expect(writes[0]?.body).toContain('workflow: ship')
    expect(writes[0]?.body).toContain('workflow_mode: default')
    expect(writes[0]?.body).toContain(`workflow_cursor: ${cursor.id}`)
    expect(writes[0]?.body).not.toContain('\nrun:')
    expect(db().query('SELECT action FROM question_mutation_audit').get()).toEqual({
      action: 'file',
    })
  })

  test('workflow filing requires owner authority or operator override and audits the actual actor', async () => {
    db()
      .query(
        `INSERT OR IGNORE INTO project (name,path,canon,settings)
         VALUES ('workflow-fixture','/fixture',1,'{}')`,
      )
      .run()
    const cursor = db()
      .query(
        `INSERT INTO workflow_cursor
          (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('workflow-fixture','ship','default','DEV-964','','owner-session',1,1,'{}',0,
                 'build','running','[]',NULL,1,'2026-09-20','2026-09-21') RETURNING id`,
      )
      .get() as { id: number }
    const question = db()
      .query(
        `INSERT INTO question
          (workflow_cursor_id,workflow_key,asked_at,question,answer,answered_at,asked_via)
         VALUES (?,'DEV-964','2026-09-20','Proceed?','Yes.','2026-09-21','workflow') RETURNING id`,
      )
      .get(cursor.id) as { id: number }
    db()
      .query('UPDATE workflow_cursor SET updated_at=? WHERE id=?')
      .run(new Date().toISOString(), cursor.id)
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'

    await expect(file({ questionId: question.id, as: 'doc' })).rejects.toThrow(
      'owned by session owner-session',
    )
    await file({ questionId: question.id, as: 'doc', fromOperator: true })
    expect(db().query('SELECT action,actor_session FROM question_mutation_audit').all()).toEqual([
      { action: 'file', actor_session: 'foreign-session' },
    ])
  })

  test('records a doc filing ref and writes demand-scoped text', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
      repo: PLATFORM_SLUG,
    })
    db().query('UPDATE run SET launch_key=? WHERE id=?').run('DEV-963', run)
    const questionId = addAnsweredQuestion(run, 'Which shape should this take?')
    const writes: unknown[] = []
    const result = await file(
      { questionId, as: 'doc' },
      stores({
        writeDoc: async (input) => {
          writes.push(input)
          return { id: 12, revision: 'rev-1' }
        },
      }),
    )
    expect(result).toEqual({
      question_id: questionId,
      filed_as: 'doc',
      filed_ref: '12@rev-1',
      filed_at: expect.any(String),
    })
    expect(writes).toEqual([
      {
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: `which-shape-should-this-take-q${questionId}`,
        title: 'Which shape should this take?',
        body: expect.stringContaining('question: |'),
        delivery: 'demand',
        reason: `file ruling ${questionId}`,
      },
    ])
    expect(writes[0]).toEqual(
      expect.objectContaining({
        body: expect.stringMatching(/ruling: \|\n {2}Keep the existing one\./),
      }),
    )
    expect(writes[0]).toEqual(
      expect.objectContaining({
        body: expect.stringContaining('The recorded ruling is filed for demand delivery.'),
      }),
    )
    expect(
      db().query('SELECT filed_as, filed_ref FROM question WHERE id=?').get(questionId),
    ).toEqual({ filed_as: 'doc', filed_ref: '12@rev-1' })
    expect(
      db().query("SELECT action, reason FROM run_mutation_audit WHERE action='file'").get(),
    ).toEqual({ action: 'file', reason: 'as doc' })
  })

  test('files the replacement for an overturned ruling', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
      repo: PLATFORM_SLUG,
    })
    const questionId = addAnsweredQuestion(run, 'Which way?', {
      answer: 'Old',
      overturned: { reason: 'New evidence', replacement: 'Use the replacement.' },
    })
    const writes: string[] = []
    await file(
      { questionId, as: 'doc' },
      stores({
        writeDoc: async (input) => {
          writes.push(input.body)
          return { id: 1, revision: 'r' }
        },
      }),
    )
    expect(writes[0]).toContain('  Use the replacement.')
  })

  test('files a canon proposal note with the prefix and records its id', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
    })
    const questionId = addAnsweredQuestion(run)
    const notes: unknown[] = []
    const result = await file(
      { questionId, as: 'canon' },
      stores({
        fileNote: async (input, options) => {
          notes.push({ input, options })
          return { output: 'note 44 filed; 1 sighting' }
        },
      }),
    )
    expect(result.filed_as).toBe('canon-proposal')
    expect(result.filed_ref).toBe('44')
    expect(notes).toEqual([
      {
        input: { text: expect.stringMatching(/^Canon proposal: /), new: true },
        options: undefined,
      },
    ])
    expect(
      db().query('SELECT filed_as, filed_ref FROM question WHERE id=?').get(questionId),
    ).toEqual({ filed_as: 'canon-proposal', filed_ref: '44' })
  })

  test('refuses an unanswered question', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'owner-session',
    })
    const questionId = (
      db()
        .query(
          `INSERT INTO question (run_id,asked_at,question) VALUES (?,'2026-09-20','Which?')
           RETURNING id`,
        )
        .get(run) as { id: number }
    ).id
    await expect(file({ questionId, as: 'doc' })).rejects.toThrow(
      `question ${questionId} is unanswered`,
    )
  })

  test('refuses an overturned ruling without a replacement', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner-session' })
    const questionId = addAnsweredQuestion(run, 'Which?', {
      overturned: { reason: 'Withdrawn', replacement: null },
    })
    await expect(file({ questionId, as: 'doc' })).rejects.toThrow(
      `question ${questionId} was overturned without a replacement`,
    )
  })

  test('refuses a second filing of the same kind and names the existing ref', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
      repo: PLATFORM_SLUG,
    })
    const questionId = addAnsweredQuestion(run)
    await file({ questionId, as: 'doc' })
    await expect(file({ questionId, as: 'doc' })).rejects.toThrow(
      `question ${questionId} is already filed as doc at 12@rev-1`,
    )
  })

  test('refuses filing as the other kind once a filing exists', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
      repo: PLATFORM_SLUG,
    })
    const questionId = addAnsweredQuestion(run)
    await file({ questionId, as: 'doc' })
    await expect(file({ questionId, as: 'canon' })).rejects.toThrow(
      `question ${questionId} is already filed as doc at 12@rev-1`,
    )
  })

  test('refuses writing canon rows through --as doc', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner-session' })
    const questionId = addAnsweredQuestion(run)
    const writes: unknown[] = []
    await expect(
      file(
        { questionId, as: 'doc', scope: 'canon' },
        stores({
          writeDoc: async (input) => {
            writes.push(input)
            return { id: 1, revision: 'r' }
          },
        }),
      ),
    ).rejects.toThrow('canon is never written directly')
    expect(writes).toEqual([])
  })

  test('refuses filing a ruling as a settings doc', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner-session' })
    const questionId = addAnsweredQuestion(run)
    const writes: unknown[] = []
    await expect(
      file(
        { questionId, as: 'doc', scope: 'settings' },
        stores({
          writeDoc: async (input) => {
            writes.push(input)
            return { id: 1, revision: 'r' }
          },
        }),
      ),
    ).rejects.toThrow('unknown doc scope "settings"')
    expect(writes).toEqual([])
  })

  test('refuses a foreign session and writes nothing', async () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
      repo: PLATFORM_SLUG,
    })
    const questionId = addAnsweredQuestion(run)
    process.env.CLAUDE_CODE_SESSION_ID = 'other-session'
    const writes: unknown[] = []
    await expect(
      file(
        { questionId, as: 'doc' },
        stores({
          writeDoc: async (input) => {
            writes.push(input)
            return { id: 1, revision: 'r' }
          },
        }),
      ),
    ).rejects.toThrow(`run ${run} is owned by session owner-session`)
    expect(writes).toEqual([])
    expect(
      db().query('SELECT filed_as, filed_ref FROM question WHERE id=?').get(questionId),
    ).toEqual({ filed_as: null, filed_ref: null })
    expect(db().query("SELECT action FROM run_mutation_audit WHERE action='file'").get()).toBeNull()
  })

  test('files through the real setDoc when the question has a task key and the ruling has a numeral', async () => {
    upsertProject({ name: PLATFORM_SLUG, path: process.cwd() })
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      session: 'owner-session',
      repo: PLATFORM_SLUG,
    })
    const questionId = addAnsweredQuestion(run, 'Which shape should DEV-963 take?', {
      answer: 'Keep the existing 2 variants.',
    })
    const result = await file(
      { questionId, as: 'doc' },
      stores({
        writeDoc: async (input) => {
          const doc = await setDoc(input)
          return { id: doc.id, revision: doc.revision }
        },
      }),
    )
    expect(result.filed_as).toBe('doc')
    const stored = getDoc(
      'project',
      PLATFORM_SLUG,
      `which-shape-should-dev-963-take-q${questionId}`,
    )
    expect(stored?.delivery).toBe('demand')
    expect(stored?.body).toContain('Which shape should DEV-963 take?')
    expect(stored?.body).toContain('Keep the existing 2 variants.')
  })
})
