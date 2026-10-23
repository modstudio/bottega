import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { markRunBoardNoticesDelivered } from '../board/board-delivery.ts'
import { BOARD_CACHE_OWNER_KEY } from '../board/board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import {
  claimRunNotices,
  markRunNoticesDelivered as markLocalRunNoticesDelivered,
  postNotice,
} from '../board/board-service.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  appendInitialRunBoardPrompt,
  BOARD_PACK_MAX_CHARS,
  BOARD_PACK_MAX_NOTICES,
  persistBoundPrompt,
  prepareLaterRunBoardPrompt,
  renderRunBoardSection,
} from './run-board-prompt.ts'

const createdAt = new Date(Date.now() - 1_000).toISOString()

test('persisting a board-bound prompt leaves the original prompt unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bound-prompt-'))
  const promptPath = join(directory, 'prompt.txt')
  writeFileSync(promptPath, 'original')
  const run = db()
    .query<{ id: string }, []>(`INSERT INTO run
    (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,turn)
    VALUES (lower(hex(randomblob(4))) || '-0000-7000-8000-' || lower(hex(randomblob(6))),(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','implement','sha','spec',8,'head','running',1)
    RETURNING record_id AS id`)
    .get()!
  persistBoundPrompt(promptPath, 'original\n\nnotice', run.id)
  expect(readFileSync(promptPath, 'utf8')).toBe('original')
  expect(readFileSync(join(directory, 'bound-prompt.txt'), 'utf8')).toContain('notice')
})

beforeEach(() => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
})
afterEach(() => {
  installRecordApiClient(null)
  delete process.env.BOTTEGA_RECORD_API_URL
})

const notice = (id: number, ackRequired: boolean, createdAt: string, text = `notice ${id}`) => ({
  id: String(id),
  ackRequired,
  createdAt,
  text,
  oneLine: text,
})

test('a dispatch-delivered notice is not returned by the worker pull path', async () => {
  const clock = Date.now() + 400_000
  const run = db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','dispatch-board-project','sha',1,'prompt','running','DEV-DISPATCH')
       RETURNING record_id AS id`,
    )
    .get(new Date(clock).toISOString()) as { id: string }
  const posted = postNotice(
    { audience: `run:${run.id}`, title: 'At dispatch', body: 'Delivered once.' },
    {},
    clock,
  )
  const bound = await appendInitialRunBoardPrompt('PROMPT', run.id)
  expect(bound.noticeIds).toEqual([String(posted.number)])
  markLocalRunNoticesDelivered(run.id, [posted.recordId], clock + 1)
  expect(claimRunNotices(run.id, false, clock + 2)).toEqual([])
})

test('dispatch and later-turn injection each combine hosted and local once with a refresh warning', async () => {
  const root = db()
    .query(
      `INSERT INTO run(record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,turn)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','prompt-project','sha',1,'prompt','running','DEV-968',1) RETURNING record_id AS id`,
    )
    .get('2026-10-05T11:00:00.000Z') as { id: string }
  const hosted = (id = newRecordId()): HostedBoardMessage => ({
    id,
    kind: 'notice',
    threadRootId: null,
    title: 'Hosted prompt',
    body: 'hosted prompt body',
    audience: `run:${root.id}`,
    origin: {
      kind: 'architect',
      session: 'remote',
      harness: 'claude',
      project: 'prompt-project',
      runId: null,
    },
    senderTags: [],
    createdAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
    withdrawnAt: null,
    state: 'open',
    acceptedReplyId: null,
    acceptedBy: null,
    acceptedAt: null,
    noteId: null,
    notePendingError: null,
    revision: '1',
    scopeProjectIds: [],
    recipientUserIds: [],
    claimId: null,
    authorUserId: newRecordId(),
    authorSession: 'remote',
    ackRequired: false,
    ackDeadline: null,
  })
  const firstHosted = hosted()
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_CACHE_OWNER_KEY, firstHosted.authorUserId)
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', firstHosted.authorUserId)
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(
      firstHosted.id,
      firstHosted.kind,
      firstHosted.threadRootId,
      firstHosted.revision,
      JSON.stringify(firstHosted),
    )
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => {
      throw new Error('prompt refresh offline\nForged-Warning: prompt')
    },
    putBoardReceipt: async () => {
      throw new Error('receipt offline')
    },
  })
  const firstLocal = postNotice(
    { audience: `run:${root.id}`, title: 'Local prompt', body: 'local prompt body' },
    {},
    Date.parse(createdAt),
  )
  const initial = await appendInitialRunBoardPrompt('PROMPT', root.id)
  expect(initial.noticeIds).toEqual([String(firstLocal.number), firstHosted.id])
  expect(initial.prompt).toContain('Local prompt')
  expect(initial.prompt).toContain('Hosted prompt')
  expect(initial.prompt).not.toContain('local prompt body')
  expect(initial.prompt).not.toContain('hosted prompt body')
  expect(initial.prompt).toContain('prompt refresh offline')
  expect(initial.prompt).toContain('offline Forged-Warning: prompt')
  expect(initial.prompt).not.toContain('offline\nForged-Warning: prompt')
  await markRunBoardNoticesDelivered(root.id, initial.noticeIds)

  const laterHosted = hosted()
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(laterHosted.id, laterHosted.kind, null, laterHosted.revision, JSON.stringify(laterHosted))
  const laterLocal = postNotice(
    { audience: `run:${root.id}`, title: 'Local later', body: 'local later body' },
    {},
    Date.parse(createdAt) + 1_000,
  )
  const later = await prepareLaterRunBoardPrompt(root.id, true, [], 'NEXT')
  expect(later.notices.map((row) => row.id)).toEqual([String(laterLocal.number), laterHosted.id])
  expect(later.prompt).toContain('Local later')
  expect(later.prompt).toContain('Hosted prompt')
  expect(later.prompt).not.toContain('local later body')
  expect(later.prompt).not.toContain('hosted prompt body')
  expect(later.prompt).toContain('prompt refresh offline')
  expect(later.prompt).not.toContain('offline\nForged-Warning: prompt')
  await markRunBoardNoticesDelivered(
    root.id,
    later.notices.map((row) => row.id),
  )
  expect((await prepareLaterRunBoardPrompt(root.id, true, [], 'NEXT')).notices).toEqual([])
})

test('dispatch board section orders acknowledgements first, then newest, and reports overflow', () => {
  const notices = [
    notice(1, false, '2026-10-01T00:00:00.000Z'),
    notice(2, true, '2026-09-01T00:00:00.000Z'),
    notice(3, false, '2026-10-03T00:00:00.000Z'),
    notice(4, false, '2026-10-04T00:00:00.000Z'),
    notice(5, false, '2026-10-05T00:00:00.000Z'),
    notice(6, false, '2026-10-06T00:00:00.000Z'),
  ]
  const rendered = renderRunBoardSection(notices)
  expect(rendered.includedIds).toEqual(['2', '6', '5', '4', '3'])
  expect(rendered.includedIds).toHaveLength(BOARD_PACK_MAX_NOTICES)
  expect(rendered.text).toContain(
    '1 more notice omitted; check_orchestrator_messages returns them.',
  )
  expect(rendered.text.length).toBeLessThanOrEqual(BOARD_PACK_MAX_CHARS)
})

test('dispatch board section keeps the character bound and counts every omitted notice', () => {
  const rendered = renderRunBoardSection([
    notice(1, true, '2026-10-02T00:00:00.000Z', 'x'.repeat(BOARD_PACK_MAX_CHARS)),
    notice(2, false, '2026-10-01T00:00:00.000Z'),
  ])
  expect(rendered.includedIds).toEqual([])
  expect(rendered.text).toContain(
    '2 more notices omitted; check_orchestrator_messages returns them.',
  )
  expect(rendered.text.length).toBeLessThanOrEqual(BOARD_PACK_MAX_CHARS)
})
