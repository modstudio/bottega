import { expect, test } from 'bun:test'
import { parseReplyAudienceOption, resolveReplyReaders } from './board-reply-audience.ts'

test('invalid and empty reply audiences use the reply vocabulary', () => {
  expect(() => parseReplyAudienceOption('')).toThrow(
    'use participants, acknowledged, audience, operator, or session:<id>',
  )
  expect(() => parseReplyAudienceOption('project:other')).toThrow(
    'use participants, acknowledged, audience, operator, or session:<id>',
  )
  expect(() => parseReplyAudienceOption('run:123')).toThrow(
    'use participants, acknowledged, audience, operator, or session:<id>',
  )
  expect(() => parseReplyAudienceOption('session:')).toThrow(
    'use participants, acknowledged, audience, operator, or session:<id>',
  )
  expect(() => parseReplyAudienceOption('session:operator')).toThrow(
    'session:operator is reserved; use audience operator',
  )
  expect(() => parseReplyAudienceOption('session:run:123')).toThrow(
    'session:run:123 is reserved; use audience run:123',
  )
})

test('reply audience choices resolve participants, acknowledgements, root audience, and recipients', () => {
  const facts = {
    rootAuthor: 'asker',
    threadAuthors: ['first', 'second'],
    loopedInSessions: ['looped-in'],
    rootReceipts: [
      { reader: 'acknowledged-reader', audienceAtPosting: true, acknowledged: true },
      { reader: 'audience-reader', audienceAtPosting: true, acknowledged: false },
      { reader: 'outside-reader', audienceAtPosting: false, acknowledged: true },
    ],
    replier: 'second',
  }
  expect(resolveReplyReaders({ ...facts, audience: null })).toEqual(['asker', 'first', 'looped-in'])
  expect(resolveReplyReaders({ ...facts, audience: { kind: 'participants' } })).toEqual([
    'asker',
    'first',
    'looped-in',
  ])
  expect(resolveReplyReaders({ ...facts, audience: { kind: 'acknowledged' } })).toEqual([
    'asker',
    'acknowledged-reader',
    'outside-reader',
  ])
  expect(resolveReplyReaders({ ...facts, audience: { kind: 'audience' } })).toEqual([
    'asker',
    'acknowledged-reader',
    'audience-reader',
  ])
  expect(
    resolveReplyReaders({ ...facts, audience: { kind: 'session', sessionId: 'recipient' } }),
  ).toEqual(['asker', 'recipient'])
  expect(resolveReplyReaders({ ...facts, audience: { kind: 'operator' } })).toEqual([
    'asker',
    'operator',
  ])
})

test('an explicit session recipient joins later participant audiences', () => {
  const first = resolveReplyReaders({
    rootAuthor: 'root',
    threadAuthors: [],
    loopedInSessions: [],
    rootReceipts: [],
    audience: { kind: 'session', sessionId: 'new' },
    replier: 'first-replier',
  })
  expect(first).toEqual(['root', 'new'])
  expect(
    resolveReplyReaders({
      rootAuthor: 'root',
      threadAuthors: ['first-replier', 'another-session'],
      loopedInSessions: ['new'],
      rootReceipts: [],
      audience: { kind: 'participants' },
      replier: 'another-session',
    }),
  ).toEqual(['root', 'first-replier', 'new'])
})

test('reply audiences always reach a different root author and never reach the replier', () => {
  expect(
    resolveReplyReaders({
      rootAuthor: 'asker',
      threadAuthors: [],
      loopedInSessions: [],
      rootReceipts: [],
      audience: { kind: 'session', sessionId: 'recipient' },
      replier: 'answerer',
    }),
  ).toContain('asker')
  expect(
    resolveReplyReaders({
      rootAuthor: 'asker',
      threadAuthors: ['answerer'],
      loopedInSessions: [],
      rootReceipts: [{ reader: 'answerer', audienceAtPosting: true, acknowledged: true }],
      audience: { kind: 'acknowledged' },
      replier: 'answerer',
    }),
  ).not.toContain('answerer')
  expect(
    resolveReplyReaders({
      rootAuthor: 'asker',
      threadAuthors: [],
      loopedInSessions: [],
      rootReceipts: [],
      audience: { kind: 'participants' },
      replier: 'asker',
    }),
  ).toEqual([])
})
