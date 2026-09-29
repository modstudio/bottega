import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { addRun } from '../../test/fixtures/store.ts'
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
              'SELECT 1 FROM question q JOIN run r ON r.id=q.run_id WHERE (r.id=? OR r.parent_run_id=?) AND q.delivery_pending_at IS NOT NULL',
            )
            .get(root, root),
        ),
      strandedRecovery: (root) => `stranded — orch retry ${root} --agent`,
    },
    options.cwd,
  )
  return lines.join('\n')
}

test('explicit project scope keeps only that project and an unregistered cwd keeps nothing', () => {
  const rows = [
    { repo: 'here', id: 1 },
    { repo: 'elsewhere', id: 2 },
    { repo: null, id: 3 },
  ]
  expect(rowsForInboxProject(rows, 'here')).toEqual([{ repo: 'here', id: 1 }])
  expect(rowsForInboxProject(rows, null)).toEqual([])
})

test('scoped inbox JSON identifies an unregistered cwd', async () => {
  expect(
    JSON.parse(await inbox({ all: true, active: true, json: true, cwd: '/unregistered' })),
  ).toEqual({ cwd_registered: false, project: null, rows: [] })
})
const question = (run: number, text: string) =>
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id')
    .get(run, new Date().toISOString(), text) as { id: number }

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
  expect(await inbox()).toContain(`orch answer ${root}`)
})

test('inbox does not list a closed question', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  const inserted = question(run, 'obsolete question')
  db()
    .query("UPDATE question SET closed_at='2026-09-29',close_reason='chain-stopped' WHERE id=?")
    .run(inserted.id)
  expect(await inbox({ all: true })).not.toContain('obsolete question')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toEqual([])
})

test('inbox shows an overturned ruling and its reason', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  db()
    .query(
      `INSERT INTO question
        (run_id,asked_at,question,answer,answered_at,overturned_at,overturned_by,overturn_reason)
       VALUES (?,'2026-09-20','Which?','Old','2026-09-21','2026-09-22','owner','Wrong evidence')`,
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
        (run_id,asked_at,question,answer,answered_at,filed_as,filed_ref,filed_at)
       VALUES (?,'2026-09-20','Which?','Keep it.','2026-09-21','doc','12@rev-1','2026-09-22')`,
    )
    .run(run)
  const output = await inbox({ all: true })
  expect(output).toContain('filed: doc 12@rev-1')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({ filed_as: 'doc', filed_ref: '12@rev-1' }),
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
      expect.objectContaining({ run_id: child, can_answer: true }),
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
  expect(shown).toContain(`run ${id} · codex/implement`)
  expect(shown).toContain('existing format?')
})
test('project inbox exposes a foreign question without adopting it', async () => {
  upsertProject({ name: 'inbox-project', path: process.cwd() })
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'inbox-project',
  })
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
  upsertProject({ name: 'live-project', path: process.cwd() })
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'live-project',
  })
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
    expect.objectContaining({ run_id: id, can_answer: false }),
  )
})
test('inbox --all shows a foreign recoverable root without offering authority', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' })
  const shown = await inbox({ all: true })
  expect(shown).toContain(`run ${id}`)
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
    .query('INSERT INTO question (run_id,asked_at,question,answer,answered_at) VALUES (?,?,?,?,?)')
    .run(active, new Date().toISOString(), 'already answered?', 'ruled', new Date().toISOString())
  question(terminal, 'terminal?')
  const rows = JSON.parse(await inbox({ all: true, active: true, json: true }))
  expect(rows).toContainEqual(
    expect.objectContaining({ run_id: active, can_answer: false, question: 'active?' }),
  )
  expect(rows).not.toContainEqual(expect.objectContaining({ question: 'already answered?' }))
  expect(rows).not.toContainEqual(expect.objectContaining({ run_id: terminal }))
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
  db().query("UPDATE run SET evidence_excluded='' WHERE id=?").run(root)
  question(child, 'voided?')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(
    expect.objectContaining({ run_id: child, status: 'voided', can_answer: false }),
  )
})
test('bare project inbox includes its questions and this session questions from other projects', async () => {
  upsertProject({ name: 'here', path: process.cwd() })
  const here = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'here',
  })
  const foreignElsewhere = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'foreign',
    repo: 'elsewhere',
  })
  const ownElsewhere = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
    repo: 'elsewhere',
  })
  question(here, 'here?')
  question(foreignElsewhere, 'foreign elsewhere?')
  question(ownElsewhere, 'own elsewhere?')
  const shown = await inbox()
  expect(shown).toContain('here?')
  expect(shown).not.toContain('foreign elsewhere?')
  expect(shown).toContain('own elsewhere?')
  expect(shown).toContain(`run ${ownElsewhere} · codex/implement · elsewhere`)
})
test('bare project inbox includes recoverable roots owned by this session in other projects', async () => {
  upsertProject({ name: 'here', path: process.cwd() })
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
  expect(shown).toContain(`run ${ownElsewhere} · codex/implement · elsewhere`)
  expect(shown).toContain(`recoverable: orch continue ${ownElsewhere}`)
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
      'INSERT INTO question (run_id,asked_at,question,answer,answered_at,delivery_pending_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      id,
      new Date().toISOString(),
      'which?',
      'ruled',
      new Date().toISOString(),
      new Date().toISOString(),
    )
  expect(await inbox()).toContain(`stranded — orch retry ${id} --agent`)
})
test('inbox and continue refuse recovery while a later chain turn is running', async () => {
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'orch-test-session',
  })
  addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
  expect(await inbox()).not.toContain(`recoverable: orch continue ${root}`)
})
