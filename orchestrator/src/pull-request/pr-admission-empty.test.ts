import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  admissionDecision,
  emptyCreateRefusal,
  emptyPrePushRefusal,
  type PullRequestChange,
} from './pr-admission.ts'

function emptyChange(): PullRequestChange {
  return {
    project: {
      name: 'fixture',
      path: '/path/that/must/not/be-read',
      settings: { trunk: 'main' },
    },
    branch: 'DEV-2350-empty',
    tip: '0123456789abcdef',
    base: '0123456789abcdef',
  } as PullRequestChange
}

function emptyAdmissionForTest(change: PullRequestChange) {
  const admission = admissionDecision(
    change,
    new Proxy(
      {},
      {
        get() {
          throw new Error('database must not be read for an empty change')
        },
      },
    ) as never,
  )
  if (admission.kind !== 'empty') throw new Error('expected an empty admission')
  return admission
}

test('create refuses an empty admission with its own remedy', () => {
  const change = emptyChange()
  expect(emptyCreateRefusal(change, emptyAdmissionForTest(change))).toBe(
    `refusing pull request for DEV-2350-empty at 0123456789abcdef: DEV-2350-empty resolves to 01234567, which is already on main, so there is no change to review; cleared by: commit the change to DEV-2350-empty, then ${PLATFORM_SLUG} pr create`,
  )
})

test('pre-push refuses an empty admission with its own remedy', () => {
  const change = emptyChange()
  expect(emptyPrePushRefusal(change, emptyAdmissionForTest(change))).toEqual({
    known: true,
    complete: false,
    infrastructureError: null,
    refusal:
      'refusing push of DEV-2350-empty at 0123456789abcdef: DEV-2350-empty resolves to 01234567, which is already on main, so there is no change to review; cleared by: commit the change to DEV-2350-empty before pushing it',
    pendingIntent: false,
    overrideId: null,
  })
})
