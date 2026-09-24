import { describe, expect, test } from 'bun:test'
import {
  REVISION_CHECK_MS,
  revisionDecision,
  type ServiceIdentity,
  serviceRevisionStatus,
} from './service-revision.ts'

const identity: ServiceIdentity = {
  holder: 'serve:42',
  pid: 42,
  revision: 'aaaa',
  revisionError: null,
  currentRevisionError: null,
  startedAt: '2026-09-17T12:00:00.000Z',
}

describe('service revision comparison', () => {
  test('reports current, stale, and gone services', () => {
    expect(serviceRevisionStatus(identity, true, { revision: 'aaaa', error: null })).toEqual({
      status: 'current',
      revision: 'aaaa',
    })
    expect(serviceRevisionStatus(identity, true, { revision: 'bbbb', error: null })).toEqual({
      status: 'stale',
      startedRevision: 'aaaa',
      currentRevision: 'bbbb',
      startedAt: identity.startedAt,
    })
    expect(serviceRevisionStatus(identity, false, { revision: 'bbbb', error: null })).toEqual({
      status: 'gone',
    })
  })

  test('attributes an unreadable comparison to startup or current HEAD', () => {
    expect(
      serviceRevisionStatus(
        { ...identity, revision: null, revisionError: 'not a checkout' },
        true,
        { revision: 'bbbb', error: null },
      ),
    ).toEqual({ status: 'unreadable', side: 'startup', reason: 'not a checkout' })
    expect(
      serviceRevisionStatus(identity, true, { revision: null, error: 'git unavailable' }),
    ).toEqual({ status: 'unreadable', side: 'current', reason: 'git unavailable' })
  })
})

describe('revision check decision', () => {
  test('checks at most once per minute and restarts only on a readable change', () => {
    expect(revisionDecision('aaaa', { revision: 'bbbb', error: null }, 10, 0)).toBe('wait')
    expect(revisionDecision('aaaa', { revision: 'aaaa', error: null }, REVISION_CHECK_MS, 0)).toBe(
      'continue',
    )
    expect(revisionDecision('aaaa', { revision: 'bbbb', error: null }, REVISION_CHECK_MS, 0)).toBe(
      'restart',
    )
    expect(
      revisionDecision('aaaa', { revision: null, error: 'failed' }, REVISION_CHECK_MS, 0),
    ).toBe('continue')
  })
})
