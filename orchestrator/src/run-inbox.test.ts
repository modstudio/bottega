import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { addRun, db, upsertProject } from '../test/fixture.ts'
import { VOIDED_SQL, activeSql, voidedSql } from './evidence-query.ts'
import { runInboxCommand } from './run-inbox.ts'

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

test('inbox voided membership is VOIDED_SQL, not a second copy', () => {
  const inbox = readFileSync(new URL('./run-inbox.ts', import.meta.url), 'utf8')
  expect(inbox).toContain("activeSql('root')")
  expect(inbox).toContain("voidedSql('root')")
  expect(inbox).not.toMatch(/evidence_excluded/)
  expect(normalize(VOIDED_SQL.replaceAll('r.', 'root.'))).toBe(normalize(voidedSql('root')))
  expect(normalize(
    VOIDED_SQL.replaceAll('r.', 'root.').replace('IS NOT NULL', 'IS NULL'),
  )).not.toBe(normalize(voidedSql('root')))
  expect(activeSql('root')).toBe(
    `root.status IN ('running','asking') AND NOT (${voidedSql('root')})`,
  )
})


beforeEach(() => { process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session' })
async function inbox(options: { all?: boolean; json?: boolean } = {}) {
  const lines: string[] = []
  await runInboxCommand({ has: (name) => Boolean(options[name as 'all' | 'json']) }, {
    log: (...values) => lines.push(values.join(' ')), dur: (ms) => String(ms ?? 0),
    chainHasPendingDelivery: (root) => Boolean(db().query(
      'SELECT 1 FROM question q JOIN run r ON r.id=q.run_id WHERE (r.id=? OR r.parent_run_id=?) AND q.delivery_pending_at IS NOT NULL',
    ).get(root, root)),
    strandedRecovery: (root) => `stranded — orch retry ${root} --agent`,
  })
  return lines.join('\n')
}
const question = (run: number, text: string) =>
  db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id')
    .get(run, new Date().toISOString(), text) as { id: number }

test('inbox names the canonical root in its answer footer', async () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'orch-test-session' })
  const child = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'orch-test-session', parent: root, turn: 2 })
  question(child, 'which?'); expect(await inbox()).toContain(`orch answer ${root}`)
})
test('inbox keeps own questions in their existing format outside a registered project', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'orch-test-session' }); question(id, 'existing format?')
  const shown = await inbox(); expect(shown).toContain(`run ${id} · codex/implement`); expect(shown).toContain('existing format?')
})
test('project inbox exposes a foreign question without adopting it', async () => {
  upsertProject({ name: 'inbox-project', path: process.cwd() })
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign', repo: 'inbox-project' }); question(id, 'foreign?')
  const shown = await inbox(); expect(shown).toContain('visible here, but owned by another session'); expect(shown).toContain('foreign?')
})
test('project inbox reports a recently-seen foreign owner as live, without authority', async () => {
  upsertProject({ name: 'live-project', path: process.cwd() })
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign', repo: 'live-project' }); question(id, 'live?')
  db().query('INSERT OR REPLACE INTO session_seen (session_id,last_seen) VALUES (?,?)').run('foreign', new Date().toISOString())
  const shown = await inbox(); expect(shown).toContain('liveness live'); expect(shown).toContain('visible here')
})
test('inbox --all keeps another live session visible but not answerable', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' }); question(id, 'all?')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(expect.objectContaining({ run_id: id, can_answer: false }))
})
test('inbox --all shows a foreign recoverable root without offering authority', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' })
  const shown = await inbox({ all: true }); expect(shown).toContain(`run ${id}`); expect(shown).toContain('only the owning session may continue it')
})
test('inbox --all --json reports live or unknown without asserting death', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' }); question(id, 'status?')
  expect(JSON.parse(await inbox({ all: true, json: true }))[0]).toMatchObject({ session_live: null, session_liveness: 'unknown' })
})
test('inbox treats an empty-string exclusion as voided, matching VOIDED_SQL', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign' }); db().query("UPDATE run SET evidence_excluded='' WHERE id=?").run(id); question(id, 'voided?')
  expect(JSON.parse(await inbox({ all: true, json: true }))).toContainEqual(expect.objectContaining({ run_id: id, status: 'voided', can_answer: false }))
})
test('bare inbox scopes visibility by checkout while ownership stays session-scoped', async () => {
  upsertProject({ name: 'here', path: process.cwd() })
  const here = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign', repo: 'here' })
  const elsewhere = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'foreign', repo: 'elsewhere' })
  question(here, 'here?'); question(elsewhere, 'elsewhere?'); const shown = await inbox()
  expect(shown).toContain('here?'); expect(shown).not.toContain('elsewhere?')
})
test('inbox marks an answered-but-undelivered chain stranded', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'orch-test-session' })
  db().query('INSERT INTO question (run_id,asked_at,question,answer,answered_at,delivery_pending_at) VALUES (?,?,?,?,?,?)')
    .run(id, new Date().toISOString(), 'which?', 'ruled', new Date().toISOString(), new Date().toISOString())
  expect(await inbox()).toContain(`stranded — orch retry ${id} --agent`)
})
test('inbox and continue refuse recovery while a later chain turn is running', async () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'orch-test-session' })
  addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
  expect(await inbox()).not.toContain(`recoverable: orch continue ${root}`)
})
