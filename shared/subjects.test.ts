import { describe, expect, test } from 'bun:test'
import { SubjectOutputSchema, subjectState } from './subjects.ts'

const subject = {
  id: '01990000-0000-7000-8000-000000000001',
  project: 'alpha',
  name: 'One',
  definition: 'One subject.',
  position: 0,
  parentId: null,
  state: 'active' as const,
  retiredAt: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
}

describe('subject output', () => {
  test('derives and validates state from the retirement timestamp', () => {
    expect(subjectState(null)).toBe('active')
    expect(subjectState(subject.updatedAt)).toBe('retired')
    expect(SubjectOutputSchema.safeParse(subject).success).toBe(true)
    expect(SubjectOutputSchema.safeParse({ ...subject, state: 'retired' }).success).toBe(false)
    expect(
      SubjectOutputSchema.safeParse({
        ...subject,
        state: 'active',
        retiredAt: subject.updatedAt,
      }).success,
    ).toBe(false)
  })
})
