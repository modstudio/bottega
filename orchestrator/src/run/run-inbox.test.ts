import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { closeTerminalChainQuestions } from '../close/close-out-questions.ts'
import { db } from '../database/db.ts'
import { VOIDED_SQL, voidedSql } from '../evidence/evidence-query.ts'
import { upsertProject } from '../project/projects.ts'
import { rowsForInboxProject, runInboxCommand } from './run-inbox.ts'

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

test('inbox voided membership is VOIDED_SQL, not a second copy', () => {
  const inbox = readFileSync(new URL('./run-inbox.ts', import.meta.url), 'utf8')
  expect(inbox).toContain("voidedSql('root')")
  expect(inbox).not.toMatch(/evidence_excluded/)
  expect(normalize(VOIDED_SQL.replaceAll('r.', 'root.'))).toBe(normalize(voidedSql('root')))
  expect(
    normalize(VOIDED_SQL.replaceAll('r.', 'root.').replace('IS NOT NULL', 'IS NULL')),
  ).not.toBe(normalize(voidedSql('root')))
})

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})
async function inbox(
  options: { all?: boolean; active?: boolean; json?: boolean; cwd?: string } = {},
) {
  const lines: string[] = []
  await runInboxCommand(
    { has: (name) => Boolean(options[name as keyof typeof options]) },
    {
      log: (...values) => lines.push(values.join(' ')),
      dur: (ms) => String(ms ?? 0),
      chainHasPendingDelivery: (root) =>
        Boolean(
          db()
            .query(
              'SELECT 1 FROM question q JOIN run r ON r.record_id=q.run_record_id WHERE (r.record_id=? OR r.parent_run_record_id=?) AND q.delivery_pending_at IS NOT NULL',
            )
            .get(root, root),
        ),
      strandedRecovery: (root) => `stranded — ${PLATFORM_SLUG} run retry ${root} --agent`,
    },
    options.cwd,
  )
  return lines.join('\n')
}

test('explicit project scope keeps only that project and an unregistered cwd keeps nothing', () => {
  const rows = [
    { project_record_id: 'here', id: 1 },
    { project_record_id: 'elsewhere', id: 2 },
    { project_record_id: null, id: 3 },
  ]
  expect(rowsForInboxProject(rows, 'here')).toEqual([{ project_record_id: 'here', id: 1 }])
  expect(rowsForInboxProject(rows, null)).toEqual([])
})

test('scoped inbox JSON identifies an unregistered cwd', async () => {
  expect(
    JSON.parse(await inbox({ all: true, active: true, json: true, cwd: '/unregistered' })),
  ).toEqual({ cwd_registered: false, project: null, rows: [] })
})
const question = (run: string, text: string) =>
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?) RETURNING number`,
    )
    .get(run, new Date().toISOString(), text) as { number: number }

const runNumber = (recordId: string): number =>
  (db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number })
    .number

test('inbox names the canonical root in its answer footer', async () => {
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
    parent: root,
    turn: 2,
  })
  question(child, 'which?')
  expect(await inbox()).toContain(`${PLATFORM_SLUG} question answer ${root}`)
})

test("inbox follows each run's questions with its own root in the answer footer", async () => {
  const rootA = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  const rootB = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  question(rootA, 'first question for A?')
  question(rootA, 'second question for A?')
  question(rootB, 'question for B?')

  const shown = await inbox()
  const headerA = `run ${runNumber(rootA)} · codex/implement`
  const headerB = `run ${runNumber(rootB)} · codex/implement`
  const startA = shown.indexOf(headerA)
  const startB = shown.indexOf(headerB)
  const groupA = shown.slice(startA, startA < startB ? startB : shown.length)
  const groupB = shown.slice(startB, startB < startA ? startA : shown.length)

  expect(groupA).toContain(`${PLATFORM_SLUG} question answer ${rootA}`)
  expect(groupA).not.toContain(`${PLATFORM_SLUG} question answer ${rootB}`)
  expect(groupB).toContain(`${PLATFORM_SLUG} question answer ${rootB}`)
  expect(groupB).not.toContain(`${PLATFORM_SLUG} question answer ${rootA}`)
})

test('inbox does not list a closed question', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  const inserted = question(run, 'obsolete question')
  db()
    .query("UPDATE question SET closed_at='2026-09-29',close_reason='chain-stopped' WHERE number=?")
    .run(inserted.number)
  expect(await inbox({ all: true })).not.toContain('obsolete question')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toEqual([])
})

test('inbox shows an overturned ruling and its reason', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  db()
    .query(
      `INSERT INTO question
        (number,record_id,run_record_id,asked_at,question,answer,answered_at,overturned_at,overturned_by,overturn_reason)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-20','Which?','Old','2026-09-21','2026-09-22','owner','Wrong evidence')`,
    )
    .run(run)
  const output = await inbox({ all: true })
  expect(output).toContain('overturned: Wrong evidence')
})
test('inbox shows a filed ruling ref', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  db()
    .query(
      `INSERT INTO question
        (number,record_id,run_record_id,asked_at,question,answer,answered_at,filed_as,filed_ref,filed_at)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-20','Which?','Keep it.','2026-09-21','doc','12@rev-1','2026-09-22')`,
    )
    .run(run)
  const output = await inbox({ all: true })
  expect(output).toContain('filed: doc 12@rev-1')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({ filed_as: 'doc', filed_ref: '12@rev-1' }),
  )
})
test('inbox shows a canon filing label and UUID', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  db()
    .query(
      `INSERT INTO question
        (number,record_id,run_record_id,asked_at,question,answer,answered_at,filed_as,filed_record_id,filed_label,filed_at)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-20','Which?','Keep it.','2026-09-21','canon-proposal',
               '11111111-1111-4111-8111-111111111111','${PLATFORM_SLUG}#44','2026-09-22')`,
    )
    .run(run)
  const output = await inbox({ all: true })
  expect(output).toContain(
    `filed: canon-proposal ${PLATFORM_SLUG}#44 (11111111-1111-4111-8111-111111111111)`,
  )
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({
      filed_ref: null,
      filed_record_id: '11111111-1111-4111-8111-111111111111',
      filed_label: `${PLATFORM_SLUG}#44`,
    }),
  )
})
test.each(['ok', 'failed'])(
  'inbox treats an asking child under a %s root as live',
  async (status) => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status,
      session: 'orch-test-session',
    })
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'orch-test-session',
      parent: root,
      turn: 2,
    })
    question(child, `${status} root continuation?`)

    expect(await inbox()).toContain(`${status} root continuation?`)
    expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
      expect.objectContaining({ run_record_id: child, can_answer: true }),
    )
  },
)
test('inbox keeps own questions in their existing format outside a registered project', async () => {
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  question(id, 'existing format?')
  const shown = await inbox()
  expect(shown).toContain(`run ${runNumber(id)} · codex/implement`)
  expect(shown).toContain('existing format?')
})
test('inbox lists workflow questions with their identity and answer command', async () => {
  const cursor = db()
    .query(
      `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES ('${newRecordId()}',1,'fixture','fixture-workflow','default','DEV-1069','','orch-test-session',?,?,
             '{"key":"DEV-1069"}',2,'fix','awaiting-ruling','[]','Which fix?',4,
             '2026-10-01','2026-10-01','floors') RETURNING record_id`,
    )
    .get(workflowVersionRecordId(db()), catalogueVersionRecordId(db())) as { record_id: string }
  const inserted = db()
    .query<{ number: number }, [string]>(
      `INSERT INTO question
      (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,asked_via,workflow_step_ordinal,workflow_step_slug)
     VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'DEV-1069','2026-10-01','Which fix?','workflow',3,'fix') RETURNING number`,
    )
    .get(cursor.record_id)!

  const shown = await inbox({ all: true })
  expect(shown).toContain('workflow fixture-workflow · fixture · mode default · step 3 fix')
  expect(shown).toContain(
    `${PLATFORM_SLUG} workflow rule fixture-workflow --project fixture --mode default --cursor 1 --arg key=DEV-1069 --ruling "<ruling>"`,
  )
  expect(shown).not.toContain('--from-operator')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({
      kind: 'workflow',
      question_id: inserted.number,
      workflow: 'fixture-workflow',
      project: 'fixture',
      mode: 'default',
      step: { n: 3, slug: 'fix' },
      can_answer: true,
      session_id: 'orch-test-session',
      answer_command: `${PLATFORM_SLUG} workflow rule fixture-workflow --project fixture --mode default --cursor 1 --arg key=DEV-1069 --ruling "<ruling>"`,
      ownership_notice: null,
    }),
  )
})

test('inbox gives no answer command for a foreign-owned workflow question', async () => {
  const cursor = db()
    .query(
      `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES ('${newRecordId()}',1,'fixture','fixture-workflow','default','DEV-1069','','foreign-session',?,?,
             '{"key":"DEV-1069"}',2,'fix','awaiting-ruling','[]','Which fix?',4,
             '2026-10-01','2026-10-01','floors') RETURNING record_id`,
    )
    .get(workflowVersionRecordId(db()), catalogueVersionRecordId(db())) as { record_id: string }
  db()
    .query(
      `INSERT INTO question
      (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,asked_via,workflow_step_ordinal,workflow_step_slug)
     VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'DEV-1069','2026-10-01','Which fix?','workflow',3,'fix')`,
    )
    .run(cursor.record_id)

  const notice =
    'owned by session foreign-session; only that session, or the operator relaying a decision, may answer it'
  const shown = await inbox({ all: true })
  expect(shown).toContain(notice)
  expect(shown).not.toContain(`answer: ${PLATFORM_SLUG} workflow rule`)
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({
      kind: 'workflow',
      can_answer: false,
      answer_command: null,
      ownership_notice: notice,
      session_id: 'foreign-session',
    }),
  )
})
test('project inbox exposes a foreign question without adopting it', async () => {
  const projectRecordId = newRecordId()
  upsertProject({ recordId: projectRecordId, name: 'inbox-project', path: process.cwd() })
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'inbox-project',
  })
  db().query('UPDATE run SET project_record_id=? WHERE record_id=?').run(projectRecordId, id)
  question(id, 'foreign?')
  const shown = await inbox()
  expect(shown).toContain('project default: rulings=agent')
  expect(shown).toContain('visible here, but owned by another session')
  expect(shown).toContain('foreign?')
  expect(shown).toContain(
    'answer what the specification or canon settles; relay a design or product-direction question to the operator and answer it with --from-operator.',
  )
})
test('project inbox reports a recently-seen foreign owner as live, without authority', async () => {
  const projectRecordId = newRecordId()
  upsertProject({ recordId: projectRecordId, name: 'live-project', path: process.cwd() })
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'live-project',
  })
  db().query('UPDATE run SET project_record_id=? WHERE record_id=?').run(projectRecordId, id)
  question(id, 'live?')
  db()
    .query('INSERT OR REPLACE INTO session_seen (session_id,last_seen) VALUES (?,?)')
    .run('foreign', new Date().toISOString())
  const shown = await inbox()
  expect(shown).toContain('liveness live')
  expect(shown).toContain('visible here')
})
test('inbox --all keeps another live session visible but not answerable', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' })
  question(id, 'all?')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({ run_record_id: id, can_answer: false }),
  )
})
test('inbox --all shows a foreign recoverable root without offering authority', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' })
  const shown = await inbox({ all: true })
  expect(shown).toContain(`run ${runNumber(id)}`)
  expect(shown).toContain('only the owning session may continue it')
})
test('inbox --all --active --json includes active foreign and omits terminal questions', async () => {
  const active = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' })
  const terminal = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    session: 'foreign',
  })
  question(active, 'active?')
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question,answer,answered_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?)`,
    )
    .run(active, new Date().toISOString(), 'already answered?', 'ruled', new Date().toISOString())
  question(terminal, 'terminal?')
  const rows = JSON.parse(await inbox({ all: true, active: true, json: true }))
  expect(rows).toContainEqual(
    expect.objectContaining({ run_record_id: active, can_answer: false, question: 'active?' }),
  )
  expect(rows).not.toContainEqual(expect.objectContaining({ question: 'already answered?' }))
  expect(rows).not.toContainEqual(expect.objectContaining({ run_record_id: terminal }))
  expect(rows[0]).toMatchObject({
    session_live: null,
    session_liveness: 'unknown',
  })
})
test('inbox treats an empty-string exclusion as voided, matching VOIDED_SQL', async () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'foreign' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    parent: root,
    turn: 2,
  })
  db().query("UPDATE run SET evidence_excluded='' WHERE record_id=?").run(root)
  question(child, 'voided?')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({ run_record_id: child, status: 'voided', can_answer: false }),
  )
})
test('bare project inbox includes its questions and this session questions from other projects', async () => {
  const hereProject = newRecordId()
  const elsewhereProject = newRecordId()
  upsertProject({ recordId: hereProject, name: 'here', path: process.cwd() })
  upsertProject({ recordId: elsewhereProject, name: 'elsewhere', path: '/elsewhere' })
  const here = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'here',
    projectRecordId: hereProject,
  })
  const foreignElsewhere = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'elsewhere',
    projectRecordId: elsewhereProject,
  })
  const ownElsewhere = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
    repo: 'elsewhere',
    projectRecordId: elsewhereProject,
  })
  question(here, 'here?')
  question(foreignElsewhere, 'foreign elsewhere?')
  question(ownElsewhere, 'own elsewhere?')
  const shown = await inbox()
  expect(shown).toContain('here?')
  expect(shown).not.toContain('foreign elsewhere?')
  expect(shown).toContain('own elsewhere?')
  expect(shown).toContain(`run ${runNumber(ownElsewhere)} · codex/implement · elsewhere`)
})
test('bare project inbox includes recoverable roots owned by this session in other projects', async () => {
  upsertProject({ recordId: newRecordId(), name: 'here', path: process.cwd() })
  const ownElsewhere = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
    repo: 'elsewhere',
  })
  const foreignElsewhere = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'elsewhere',
  })
  const shown = await inbox()
  expect(shown).toContain(`run ${runNumber(ownElsewhere)} · codex/implement · elsewhere`)
  expect(shown).toContain(`recoverable: ${PLATFORM_SLUG} run continue ${ownElsewhere}`)
  expect(shown).not.toContain(`run ${foreignElsewhere}`)
})
test('inbox marks an answered-but-undelivered chain stranded', async () => {
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question,answer,answered_at,delivery_pending_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?,?)`,
    )
    .run(
      id,
      new Date().toISOString(),
      'which?',
      'ruled',
      new Date().toISOString(),
      new Date().toISOString(),
    )
  expect(await inbox()).toContain(`stranded — ${PLATFORM_SLUG} run retry ${id} --agent`)
})
test('close-out retires a stale chain pending delivery from the inbox', async () => {
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'stale',
    session: 'orch-test-session',
  })
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question,answer,answered_at,delivery_pending_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?,?)`,
    )
    .run(
      id,
      new Date().toISOString(),
      'which?',
      'ruled',
      new Date().toISOString(),
      new Date().toISOString(),
    )
  expect(await inbox()).toContain(`stranded — ${PLATFORM_SLUG} run retry ${id} --agent`)

  closeTerminalChainQuestions(id, false)

  expect(await inbox()).not.toContain(`run ${id}`)
  expect(
    db()
      .query(
        'SELECT outcome,error FROM question_delivery WHERE question_record_id=(SELECT record_id FROM question WHERE run_record_id=?)',
      )
      .get(id),
  ).toEqual({ outcome: 'retired', error: 'chain-terminal' })
})
test('inbox and continue refuse recovery while a later chain turn is running', async () => {
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
  expect(await inbox()).not.toContain(`recoverable: ${PLATFORM_SLUG} run continue ${root}`)
})
