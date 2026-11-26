import { describe, expect, test } from 'bun:test'
import { projectGetsPack } from './project-gets-pack.ts'

describe('projectGetsPack', () => {
  test.each([
    ['retired project', '2026-09-15T00:00:00.000Z', 'project-space', true, false],
    ['hosted live project with a space', null, 'project-space', true, true],
    ['hosted live project without a space', null, null, true, false],
    ['local live project without a space', null, null, false, true],
  ] as const)('%s', (_label, retiredAt, declaredSpace, hostedRead, expected) => {
    expect(projectGetsPack({ retiredAt, declaredSpace, hostedRead })).toBe(expected)
  })
})
