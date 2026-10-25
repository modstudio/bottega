import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { consumeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { handoffConsumedResumeBrief } from './resume-brief-handoff.ts'

const previousSession = process.env.CLAUDE_CODE_SESSION_ID
const machine = '00000000-0000-4000-8000-000000000001'

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'brief-author'
  upsertProject({
    recordId: newRecordId(),
    name: 'handoff-project',
    path: '/w/handoff-project',
    settings: {},
  })
})

afterEach(() => {
  if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = previousSession
})

async function brief() {
  return setDoc({
    scope: 'resume',
    subject: 'handoff-project',
    slug: 'dev-1722',
    title: 'Handoff',
    body: '---\nstatus: open\nepic: DEV-1722\nproject: handoff-project\nwritten: 2026-10-24T00:00:00.000Z\n---\n\nNEXT ACTION: continue\n',
  })
}

function authorSeen(): void {
  db()
    .query('INSERT INTO session_seen(session_id,last_seen,ancestor_chain) VALUES (?,?,?)')
    .run(
      'brief-author',
      '2026-10-24T00:00:00.000Z',
      JSON.stringify([
        { pid: 987_654, startTime: 'transient-start' },
        { pid: 987_655, startTime: 'author-start' },
      ]),
    )
}

test("a successor consuming a resume brief receives the author's runs", async () => {
  const stored = await brief()
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'brief-author' })
  authorSeen()
  process.env.CLAUDE_CODE_SESSION_ID = 'brief-consumer'
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)

  const handoff = await handoffConsumedResumeBrief(consumed, {
    database: db(),
    probe: () => ({ alive: false, startTime: null }),
    machine,
  })

  expect(consumed.already_consumed).toBe(false)
  expect(handoff.status).toBe('moved')
  expect(handoff.report?.runs.map(({ recordId }) => recordId)).toEqual([root])
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(root)).toEqual({
    session_id: 'brief-consumer',
  })
})

test('the author consuming their own brief transfers nothing', async () => {
  const stored = await brief()
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)
  const handoff = await handoffConsumedResumeBrief(consumed, { database: db() })

  expect(handoff).toMatchObject({ status: 'skipped', authorSession: 'brief-author', report: null })
})

test('a live author does not fail consume and names the explicit adopt command', async () => {
  const stored = await brief()
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'brief-author' })
  authorSeen()
  process.env.CLAUDE_CODE_SESSION_ID = 'brief-consumer'
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)
  const handoff = await handoffConsumedResumeBrief(consumed, {
    database: db(),
    probe: (pid) =>
      pid === 987_654
        ? { alive: false, startTime: null }
        : { alive: true, startTime: 'author-start' },
    machine,
  })

  expect(consumed.body).toContain('status: consumed')
  expect(handoff.status).toBe('refused')
  expect(handoff.lines.join('\n')).toContain(`${PLATFORM_SLUG} session adopt brief-author --reason`)
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(root)).toEqual({
    session_id: 'brief-author',
  })
})
