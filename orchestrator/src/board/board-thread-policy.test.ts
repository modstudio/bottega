import { expect, test } from 'bun:test'
import {
  acceptRefusal,
  BOARD_NOTE_FILING_LEASE_MS,
  noteFilingLeaseDecision,
  replyRefusal,
  resolveReplyReaders,
  threadParticipants,
} from './board-thread-policy.ts'

const root = {
  id: 7,
  kind: 'question',
  authorReader: 'asker',
  audienceKind: 'project' as const,
  live: true,
  accepted: false,
}

test('reply permission covers operator, author, addressed and receipt-holding architects', () => {
  expect(
    replyRefusal({
      actor: { kind: 'operator', reader: 'operator' },
      root,
      addressed: false,
      hasReceipt: false,
    }),
  ).toBeNull()
  expect(
    replyRefusal({
      actor: { kind: 'architect', reader: 'asker' },
      root,
      addressed: false,
      hasReceipt: false,
    }),
  ).toBeNull()
  expect(
    replyRefusal({
      actor: { kind: 'architect', reader: 'reader' },
      root,
      addressed: true,
      hasReceipt: false,
    }),
  ).toBeNull()
  expect(
    replyRefusal({
      actor: { kind: 'architect', reader: 'reader' },
      root,
      addressed: false,
      hasReceipt: true,
    }),
  ).toBeNull()
})

test('reply refusals name broadcasts, dead roots, suggestions, accepted questions, and strangers', () => {
  const actor = { kind: 'architect' as const, reader: 'reader' }
  expect(
    replyRefusal({
      actor,
      root: { ...root, audienceKind: 'architects' },
      addressed: true,
      hasReceipt: true,
    }),
  ).toContain('broadcast')
  expect(
    replyRefusal({ actor, root: { ...root, live: false }, addressed: true, hasReceipt: true }),
  ).toContain('not live')
  expect(
    replyRefusal({
      actor,
      root: { ...root, kind: 'suggestion' },
      addressed: true,
      hasReceipt: true,
    }),
  ).toContain('suggestion')
  expect(
    replyRefusal({ actor, root: { ...root, accepted: true }, addressed: true, hasReceipt: true }),
  ).toContain('accepted answer')
  expect(replyRefusal({ actor, root, addressed: false, hasReceipt: false })).toContain('no receipt')
})

test('acceptance belongs to the asker or operator and only an open question', () => {
  const input = {
    questionId: 7,
    questionKind: 'question',
    authorReader: 'asker',
    accepted: false,
    live: true,
  }
  expect(acceptRefusal({ ...input, actor: { kind: 'operator', reader: 'operator' } })).toBeNull()
  expect(acceptRefusal({ ...input, actor: { kind: 'architect', reader: 'asker' } })).toBeNull()
  expect(acceptRefusal({ ...input, actor: { kind: 'architect', reader: 'other' } })).toContain(
    'question author',
  )
  expect(
    acceptRefusal({
      ...input,
      actor: { kind: 'architect', reader: 'asker' },
      questionKind: 'notice',
    }),
  ).toContain('not a question')
  expect(
    acceptRefusal({
      ...input,
      actor: { kind: 'architect', reader: 'asker' },
      accepted: true,
    }),
  ).toContain('final')
})

test('participants are unique, ordered, and exclude the replier', () => {
  expect(threadParticipants('asker', ['first', 'asker', 'second', 'first'], 'second')).toEqual([
    'asker',
    'first',
  ])
})

test('reply audience choices resolve participants, acknowledgements, root audience, and recipients', () => {
  const facts = {
    rootAuthor: 'asker',
    threadAuthors: ['first', 'second'],
    rootReceipts: [
      { reader: 'acknowledged-reader', audienceAtPosting: true, acknowledged: true },
      { reader: 'audience-reader', audienceAtPosting: true, acknowledged: false },
      { reader: 'outside-reader', audienceAtPosting: false, acknowledged: true },
    ],
    replier: 'second',
  }
  expect(resolveReplyReaders({ ...facts, audience: null })).toEqual(['asker', 'first'])
  expect(resolveReplyReaders({ ...facts, audience: 'participants' })).toEqual(['asker', 'first'])
  expect(resolveReplyReaders({ ...facts, audience: 'acknowledged' })).toEqual([
    'asker',
    'acknowledged-reader',
    'outside-reader',
  ])
  expect(resolveReplyReaders({ ...facts, audience: 'audience' })).toEqual([
    'asker',
    'acknowledged-reader',
    'audience-reader',
  ])
  expect(resolveReplyReaders({ ...facts, audience: 'session:recipient' })).toEqual([
    'asker',
    'recipient',
  ])
  expect(resolveReplyReaders({ ...facts, audience: 'run:123' })).toEqual(['asker', 'run:123'])
  expect(resolveReplyReaders({ ...facts, audience: 'operator' })).toEqual(['asker', 'operator'])
})

test('reply audiences always reach a different root author and never reach the replier', () => {
  expect(
    resolveReplyReaders({
      rootAuthor: 'asker',
      threadAuthors: [],
      rootReceipts: [],
      audience: 'session:recipient',
      replier: 'answerer',
    }),
  ).toContain('asker')
  expect(
    resolveReplyReaders({
      rootAuthor: 'asker',
      threadAuthors: ['answerer'],
      rootReceipts: [{ reader: 'answerer', audienceAtPosting: true, acknowledged: true }],
      audience: 'acknowledged',
      replier: 'answerer',
    }),
  ).not.toContain('answerer')
  expect(
    resolveReplyReaders({
      rootAuthor: 'asker',
      threadAuthors: [],
      rootReceipts: [],
      audience: 'participants',
      replier: 'asker',
    }),
  ).toEqual([])
})

test('note filing lease decisions distinguish filed, active, and stale leases', () => {
  const clock = Date.parse('2026-10-05T12:00:00.000Z')
  expect(noteFilingLeaseDecision('note-record-id', null, clock)).toEqual({
    kind: 'filed',
    noteId: 'note-record-id',
  })
  expect(noteFilingLeaseDecision(null, null, clock)).toEqual({ kind: 'take' })
  expect(
    noteFilingLeaseDecision(
      null,
      new Date(clock - BOARD_NOTE_FILING_LEASE_MS + 1).toISOString(),
      clock,
    ),
  ).toEqual({ kind: 'in-progress', retryAt: clock + 1 })
  expect(
    noteFilingLeaseDecision(
      null,
      new Date(clock - BOARD_NOTE_FILING_LEASE_MS).toISOString(),
      clock,
    ),
  ).toEqual({ kind: 'take' })
})
