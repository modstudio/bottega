import { expect, test } from 'bun:test'
import {
  HUB_IDENTITY_SET_PAGE_SIZE,
  parseIdentitySetPage,
  parseIdentitySetRequest,
  parseIdentitySetTable,
} from './identity-set-contract.ts'

test('parseIdentitySetTable accepts every pushable table and refuses others', () => {
  expect(parseIdentitySetTable('hub_interval')).toBe('hub_interval')
  expect(() => parseIdentitySetTable('hub_note')).toThrow(/table must name one of/)
  expect(() =>
    parseIdentitySetRequest(
      new URL('https://hub.example.test/v1/changes/ids?table=hub_task&after=nope'),
    ),
  ).toThrow('after must be a UUID')
  expect(
    parseIdentitySetRequest(
      new URL(
        'https://hub.example.test/v1/changes/ids?table=hub_task&after=01990000-0000-7000-8000-000000000001',
      ),
    ),
  ).toEqual({
    table: 'hub_task',
    after: '01990000-0000-7000-8000-000000000001',
  })
})

test('parseIdentitySetPage requires UUID ids, a more flag, and a full last page', () => {
  const id = '01990000-0000-7000-8000-000000000001'
  expect(parseIdentitySetPage({ ids: [id], more: false })).toEqual({ ids: [id], more: false })
  expect(() => parseIdentitySetPage({ ids: ['nope'], more: false })).toThrow('ids must be UUIDs')
  expect(() => parseIdentitySetPage({ ids: [id], more: 'yes' })).toThrow('more must be a boolean')
  expect(() => parseIdentitySetPage({ ids: [], more: true })).toThrow('more is true with no ids')
  expect(() => parseIdentitySetPage({ ids: [id], more: true })).toThrow(
    `more is true below page size ${HUB_IDENTITY_SET_PAGE_SIZE}`,
  )
})
