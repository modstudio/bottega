import { expect, test } from 'bun:test'
import { parseAudience } from '../board/board-policy.ts'
import type { HostedBoardCreateContent } from './record-board-contract.ts'
import {
  hostedBoardActor,
  hostedBoardPostRefusal,
  hostedBoardScope,
  hostedProjectNameForAudience,
  hostedUuidList,
  sameHostedBoardCreateContent,
} from './record-board-scope.ts'

const empty: HostedBoardCreateContent = {
  kind: 'notice',
  audience: 'operator',
  title: 'Title',
  body: 'Body',
  ackRequired: false,
  ackDeadline: null,
  expiresAt: '2026-10-06T00:00:00.000Z',
  threadRootId: null,
  scopeProjectIds: [],
  recipientUserIds: [],
  claimId: null,
  senderTags: [],
}

test('hosted actor is the operator without a session and an architect with one', () => {
  expect(hostedBoardActor(undefined)).toEqual({ kind: 'operator', session: null })
  expect(hostedBoardActor('  ')).toEqual({ kind: 'operator', session: null })
  expect(hostedBoardActor('sess-1')).toEqual({ kind: 'architect', session: 'sess-1' })
})

test('hosted post refuses machine audiences and suggestions', () => {
  expect(hostedBoardPostRefusal('suggestion', parseAudience('operator'))).toContain('suggestions')
  expect(hostedBoardPostRefusal('notice', parseAudience('machine:host'))).toContain(
    'machine audiences',
  )
  expect(hostedBoardPostRefusal('notice', parseAudience('project:alpha'))).toBeNull()
})

test('scope is the one project for project, workers, and task audiences', () => {
  const project = '03990000-0000-7000-8000-000000000001'
  expect(hostedBoardScope(parseAudience('project:alpha'), project)).toEqual({
    scopeProjectIds: [project],
    recipientUserIds: [],
  })
  expect(hostedBoardScope(parseAudience('workers:alpha'), project)).toEqual({
    scopeProjectIds: [project],
    recipientUserIds: [],
  })
  expect(hostedBoardScope(parseAudience('task:DEV-1'), project)).toEqual({
    scopeProjectIds: [project],
    recipientUserIds: [],
  })
  expect(hostedProjectNameForAudience(parseAudience('task:DEV-1'), 'alpha')).toBe('alpha')
  expect(hostedProjectNameForAudience(parseAudience('task:DEV-1'), undefined)).toBeNull()
})

test('operator, architects, session, and run audiences have empty scope and recipients', () => {
  expect(hostedBoardScope(parseAudience('operator'), null)).toEqual({
    scopeProjectIds: [],
    recipientUserIds: [],
  })
  expect(hostedBoardScope(parseAudience('architects'), null)).toEqual({
    scopeProjectIds: [],
    recipientUserIds: [],
  })
  expect(hostedBoardScope(parseAudience('session:abc'), null)).toEqual({
    scopeProjectIds: [],
    recipientUserIds: [],
  })
  expect(hostedBoardScope(parseAudience('run:01990000-0000-7000-8000-0000000000aa'), null)).toEqual(
    {
      scopeProjectIds: [],
      recipientUserIds: [],
    },
  )
})

test('idempotent create content ignores author identity and treats equal timestamps as the same', () => {
  expect(
    sameHostedBoardCreateContent(empty, {
      ...empty,
      expiresAt: '2026-10-06T00:00:00.000Z',
    }),
  ).toBeTrue()
  expect(sameHostedBoardCreateContent(empty, { ...empty, body: 'Other' })).toBeFalse()
  expect(
    sameHostedBoardCreateContent(empty, {
      ...empty,
      senderTags: [{ kind: 'topic', value: 'gate' }],
    }),
  ).toBeFalse()
  expect(
    sameHostedBoardCreateContent(
      { ...empty, scopeProjectIds: ['b', 'a'] },
      { ...empty, scopeProjectIds: ['a', 'b'] },
    ),
  ).toBeTrue()
})

test('hosted uuid lists decode Postgres array literals the JS array check misses', () => {
  const id = '03990000-0000-7000-8000-000000000011'
  expect(hostedUuidList(`{${id}}`)).toEqual([id])
  expect(hostedUuidList([id])).toEqual([id])
  expect(hostedUuidList(null)).toEqual([])
  expect(hostedUuidList('{}')).toEqual([])
  expect(
    sameHostedBoardCreateContent(
      { ...empty, scopeProjectIds: hostedUuidList(`{${id}}`) },
      { ...empty, scopeProjectIds: [id] },
    ),
  ).toBeTrue()
}))
