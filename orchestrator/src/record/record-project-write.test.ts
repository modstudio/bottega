import { describe, expect, test } from 'bun:test'
import { decideHostedProjectWrite, hostedProjectCollisionMessage } from './record-project-write.ts'

const path = '/w/alpha'
const current = { id: 'id-current', name: 'alpha', retiredAt: null, checkoutPath: path }
const nextLive = { id: 'id-next', name: 'beta', retiredAt: null, checkoutPath: '/w/beta' }
const nextSamePath = { id: 'id-next', name: 'beta', retiredAt: null, checkoutPath: path }

describe('decideHostedProjectWrite', () => {
  test('renames in place when the old hosted row exists and the new name is free', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        path,
        current,
        next: null,
      }),
    ).toEqual({ kind: 'rename', id: 'id-current', from: 'alpha', to: 'beta' })
  })

  test('upserts the new name when the old hosted row is missing', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        path,
        current: null,
        next: null,
      }),
    ).toEqual({ kind: 'upsert', name: 'beta' })
  })

  test('treats a retry after a partial rename as already applied when the new row has this path', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        path,
        current: null,
        next: nextSamePath,
      }),
    ).toEqual({ kind: 'upsert', name: 'beta' })
  })

  test('refuses a new name whose checkout path belongs to a different project', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        path,
        current: null,
        next: nextLive,
      }),
    ).toEqual({
      kind: 'refuse',
      message: hostedProjectCollisionMessage('alpha', 'beta'),
    })
  })

  test('refuses a live name collision without writing', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        path,
        current,
        next: nextLive,
      }),
    ).toEqual({
      kind: 'refuse',
      message: hostedProjectCollisionMessage('alpha', 'beta'),
    })
  })

  test('upserts when the name is unchanged', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'alpha',
        path,
        current,
        next: current,
      }),
    ).toEqual({ kind: 'upsert', name: 'alpha' })
  })
})
