import { describe, expect, test } from 'bun:test'
import { decideHostedProjectWrite, hostedProjectCollisionMessage } from './record-project-write.ts'

const current = { id: 'id-current', name: 'alpha', retiredAt: null }
const nextLive = { id: 'id-next', name: 'beta', retiredAt: null }

describe('decideHostedProjectWrite', () => {
  test('renames in place when the old hosted row exists and the new name is free', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
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
        current: null,
        next: null,
      }),
    ).toEqual({ kind: 'upsert', name: 'beta' })
  })

  test('refuses a live name collision without writing', () => {
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        current,
        next: nextLive,
      }),
    ).toEqual({
      kind: 'refuse',
      message: hostedProjectCollisionMessage('alpha', 'beta'),
    })
    expect(
      decideHostedProjectWrite({
        currentName: 'alpha',
        nextName: 'beta',
        current: null,
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
        current,
        next: current,
      }),
    ).toEqual({ kind: 'upsert', name: 'alpha' })
  })
})
