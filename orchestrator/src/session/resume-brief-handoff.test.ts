import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { consumeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { getDoc, listDocRevisions, restoreDoc } from '../doc/docs.ts'
import { resumeBriefAuthorSession } from '../doc/resume-brief-author.ts'
import { upsertProject } from '../project/projects.ts'
import { handoffConsumedResumeBrief, prepareResumeBriefHandoff } from './resume-brief-handoff.ts'

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

test('a resume handoff with unknown process evidence still moves the author runs', async () => {
  const stored = await brief()
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'brief-author' })
  process.env.CLAUDE_CODE_SESSION_ID = 'brief-consumer'
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)

  const handoff = await handoffConsumedResumeBrief(consumed, { database: db(), machine })

  expect(handoff.status).toBe('moved')
  expect(handoff.report?.runs.map(({ recordId }) => recordId)).toEqual([root])
})

test('a reopened brief hands off runs from the session that authored the current lifecycle', async () => {
  const stored = await brief()
  const openRevision = listDocRevisions('resume', 'handoff-project', stored.slug)[0]!.record_id
  await consumeDoc('resume', 'handoff-project', stored.slug)
  process.env.CLAUDE_CODE_SESSION_ID = 'second-brief-author'
  await restoreDoc('resume', 'handoff-project', stored.slug, openRevision, {
    reason: 'reopen for the next author',
  })
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    session: 'second-brief-author',
  })
  process.env.CLAUDE_CODE_SESSION_ID = 'third-brief-consumer'
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)

  const handoff = await handoffConsumedResumeBrief(consumed, { database: db(), machine })

  expect(handoff).toMatchObject({ status: 'moved', authorSession: 'second-brief-author' })
  expect(handoff.report?.runs.map(({ recordId }) => recordId)).toEqual([root])
})

test('the author consuming their own brief transfers nothing', async () => {
  const stored = await brief()
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)
  const handoff = await handoffConsumedResumeBrief(consumed, { database: db() })

  expect(handoff).toMatchObject({ status: 'skipped', authorSession: 'brief-author', report: null })
})

test('handoff skips non-resume and already-consumed documents inside the service', async () => {
  const global = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'not-a-resume',
    title: 'Not a resume',
    body: '---\nstatus: open\n---\n\nBODY\n',
  })
  const consumedGlobal = await consumeDoc('global', null, global.slug)
  expect(
    await handoffConsumedResumeBrief(consumedGlobal, { database: db(), machine }),
  ).toMatchObject({ status: 'skipped', authorSession: null })

  const stored = await brief()
  await consumeDoc('resume', 'handoff-project', stored.slug)
  const alreadyConsumed = await consumeDoc('resume', 'handoff-project', stored.slug)
  expect(alreadyConsumed.already_consumed).toBe(true)
  expect(
    await handoffConsumedResumeBrief(alreadyConsumed, { database: db(), machine }),
  ).toMatchObject({ status: 'skipped', authorSession: null })
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

test('hosted author preparation resolves the latest non-consume revision author', async () => {
  const stored = await brief()
  const localRevision = listDocRevisions('resume', 'handoff-project', stored.slug)[0]!.record_id
  const hostedRoot = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    session: 'hosted-brief-author',
  })
  let localHostedReads = 0
  expect(
    await resumeBriefAuthorSession(stored, db(), {
      writeDecision: 'local-authoritative',
      listHostedRevisions: async () => {
        localHostedReads += 1
        return []
      },
    }),
  ).toBe('brief-author')
  expect(localHostedReads).toBe(0)

  process.env.CLAUDE_CODE_SESSION_ID = 'brief-consumer'
  await expect(
    prepareResumeBriefHandoff(getDoc('resume', 'handoff-project', stored.slug), {
      database: db(),
      machine,
      author: {
        writeDecision: 'hosted',
        listHostedRevisions: async () => {
          throw new Error('hosted record unavailable')
        },
      },
    }),
  ).rejects.toThrow('consume again when the hosted record is reachable')
  expect(getDoc('resume', 'handoff-project', stored.slug)?.body).toContain('status: open')

  const resolvedAuthor = await resumeBriefAuthorSession(stored, db(), {
    writeDecision: 'hosted',
    listHostedRevisions: async () => [
      {
        id: newRecordId(),
        op: 'consume',
        sessionId: 'brief-consumer',
        at: '2026-10-25T06:00:00.000Z',
      },
      {
        id: localRevision,
        op: 'create',
        sessionId: null,
        at: '2026-10-25T05:00:00.000Z',
      },
    ],
  })
  expect(resolvedAuthor).toBe('brief-author')
  expect(resolvedAuthor).not.toBe('brief-consumer')

  const unknown = await prepareResumeBriefHandoff(
    getDoc('resume', 'handoff-project', stored.slug),
    {
      database: db(),
      machine,
      author: {
        writeDecision: 'hosted',
        listHostedRevisions: async () => [
          {
            id: newRecordId(),
            op: 'set',
            sessionId: null,
            at: '2026-10-25T06:00:00.000Z',
          },
          {
            id: newRecordId(),
            op: 'create',
            sessionId: 'older-hosted-author',
            at: '2026-10-25T04:00:00.000Z',
          },
        ],
      },
    },
  )
  const unknownHandoff = await unknown({ ...stored, already_consumed: false })
  expect(unknownHandoff).toMatchObject({ status: 'skipped', authorSession: null })
  expect(unknownHandoff.lines.join('\n')).toContain(
    `${PLATFORM_SLUG} session adopt <session> --reason <why>`,
  )

  const finish = await prepareResumeBriefHandoff(getDoc('resume', 'handoff-project', stored.slug), {
    database: db(),
    machine,
    author: {
      writeDecision: 'hosted',
      listHostedRevisions: async () => [
        {
          id: newRecordId(),
          op: 'set',
          sessionId: 'hosted-brief-author',
          at: '2026-10-25T05:00:00.000Z',
        },
      ],
    },
  })
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)
  const handoff = await finish(consumed)

  expect(handoff).toMatchObject({ status: 'moved', authorSession: 'hosted-brief-author' })
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(hostedRoot)).toEqual({
    session_id: 'brief-consumer',
  })
})

test('a handoff with no local runs names this machine and the cross-machine remedy', async () => {
  const stored = await brief()
  process.env.CLAUDE_CODE_SESSION_ID = 'brief-consumer'
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)

  const handoff = await handoffConsumedResumeBrief(consumed, { database: db(), machine })

  expect(handoff).toMatchObject({ status: 'moved', authorSession: 'brief-author' })
  expect(handoff.lines).toEqual([
    `resume handoff: session brief-author owns no runs on machine ${machine}; runs the author left on another machine stay there; on that machine run ${PLATFORM_SLUG} session adopt brief-author --reason "resume brief handoff-project/${stored.slug} consumed by brief-consumer"`,
  ])
})

test('handoff reports the current owner when transfer loses to a third session', async () => {
  const stored = await brief()
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    session: 'brief-author',
  })
  process.env.CLAUDE_CODE_SESSION_ID = 'brief-consumer'
  const consumed = await consumeDoc('resume', 'handoff-project', stored.slug)

  const handoff = await handoffConsumedResumeBrief(consumed, {
    database: db(),
    machine,
    transfer: (rootId) => {
      db().query('UPDATE run SET session_id=? WHERE record_id=?').run('third-session', rootId)
      return false
    },
  })

  expect(handoff.report?.notMoved).toEqual([
    expect.objectContaining({ recordId: root, currentOwner: 'third-session' }),
  ])
  expect(handoff.lines.join('\n')).toContain(`run ${root} is now owned by third-session`)
  expect(handoff.lines.join('\n')).not.toContain('remain with brief-author')
})
