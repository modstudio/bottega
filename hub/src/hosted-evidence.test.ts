import { expect, test } from 'bun:test'
import { decideHostedIntervalPut } from './hosted-evidence.ts'

test('an unknown id with a known tuple re-keys the hosted row', () => {
  expect(decideHostedIntervalPut('client-id', null, 'server-id')).toEqual({
    kind: 'rekey',
    fromId: 'server-id',
    toId: 'client-id',
  })
})

test('a known id updates that row', () => {
  expect(decideHostedIntervalPut('client-id', 'client-id', 'client-id')).toEqual({
    kind: 'update',
    id: 'client-id',
  })
})

test('an unknown id with no matching tuple inserts', () => {
  expect(decideHostedIntervalPut('client-id', null, null)).toEqual({
    kind: 'insert',
    id: 'client-id',
  })
})

test('a PUT without id follows the legacy mint path', () => {
  expect(decideHostedIntervalPut(undefined, null, 'server-id')).toEqual({ kind: 'insert-legacy' })
})
