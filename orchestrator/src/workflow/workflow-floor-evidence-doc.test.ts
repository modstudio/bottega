import { expect, test } from 'bun:test'
import { docAdmissibleAsCursorEvidence } from './workflow-floor-evidence.ts'

test('accepts a document in a project-less scope on any cursor', () => {
  expect(
    docAdmissibleAsCursorEvidence({ scope: 'global', subject: null, projectName: null }, 'fixture'),
  ).toBe(true)
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'machine', subject: null, projectName: null },
      'fixture',
    ),
  ).toBe(true)
})

test("accepts a document scoped to the cursor's own project", () => {
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'project', subject: 'fixture', projectName: 'fixture' },
      'fixture',
    ),
  ).toBe(true)
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'resume', subject: 'fixture', projectName: null },
      'fixture',
    ),
  ).toBe(true)
})

test('refuses a document scoped to another project', () => {
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'project', subject: 'other', projectName: 'other' },
      'fixture',
    ),
  ).toBe(false)
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'resume', subject: 'other', projectName: null },
      'fixture',
    ),
  ).toBe(false)
})
