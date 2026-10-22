import { describe, expect, test } from 'bun:test'
import { annotateHeldTreeDetail, closeOutHoldIsInFlightLanding } from './close-out-report.ts'

describe('close-out held-tree report shape', () => {
  test('in-flight for this tree prefixes the hold so Stop can list it without blocking', () => {
    expect(
      annotateHeldTreeDetail('landing tree held by session owner: landing is in flight', {
        ref: 'cursor 459 merge-pr',
        suppressBlock: true,
      }),
    ).toBe(
      'in flight (cursor 459 merge-pr); landing tree held by session owner: landing is in flight',
    )
  })

  test('a unique-work hold keeps the in-flight fact as a suffix', () => {
    expect(
      annotateHeldTreeDetail('landing tree held by session owner: tree is dirty', {
        ref: 'cursor 459 merge-pr',
        suppressBlock: false,
      }),
    ).toBe('landing tree held by session owner: tree is dirty; in flight (cursor 459 merge-pr)')
  })

  test('only landing-in-flight and unlanded holds are the in-flight landing hold', () => {
    expect(
      closeOutHoldIsInFlightLanding('landing tree held by session owner: landing is in flight'),
    ).toBe(true)
    expect(
      closeOutHoldIsInFlightLanding(
        'landing tree held by session owner: branch has not landed; session owner releases it',
      ),
    ).toBe(true)
    expect(closeOutHoldIsInFlightLanding('landing tree held by session owner: tree is dirty')).toBe(
      false,
    )
  })
})
