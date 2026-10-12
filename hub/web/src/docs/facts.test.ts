import { describe, expect, test } from 'bun:test'
import { revisionRelativeTime } from './facts.tsx'

describe('revisionRelativeTime', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z')

  test('keeps revision ages relative through days', () => {
    expect(revisionRelativeTime('2026-10-12T11:59:30.000Z', now)).toBe('now')
    expect(revisionRelativeTime('2026-10-12T11:30:00.000Z', now)).toBe('30m ago')
    expect(revisionRelativeTime('2026-10-12T09:00:00.000Z', now)).toBe('3h ago')
    expect(revisionRelativeTime('2026-10-09T12:00:00.000Z', now)).toBe('3d ago')
  })
})
