import { expect, test } from 'bun:test'
import { parseReplyAudienceOption, resolveReplyReaders } from './board-reply-audience.ts'

test('invalid and empty reply audiences use the reply vocabulary', () => {
  expect(() => parseReplyAudienceOption('')).toThrow(
    'use participants, acknowledged, audience, operator, session:<id>, or run:<id>',
  )
  expect(() => parseReplyAudienceOption('project:other')).toThrow(
    'use participants, acknowledged, audience, operator, session:<id>, or run:<id>',
  )
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
