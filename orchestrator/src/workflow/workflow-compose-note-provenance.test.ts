import { expect, test } from 'bun:test'
import { decidePlanTaskNoteProvenance } from './workflow-compose-note-provenance.ts'

const input = { workflow: 'plan-task', project: 'fixture', key: 'DEV-7' }

test('refuses a note-promoted plan-task with the fix-defect remedy', () => {
  expect(
    decidePlanTaskNoteProvenance({
      ...input,
      read: { kind: 'available', notes: [{ label: 'fixture#3', promotedTask: 'DEV-7' }] },
    }),
  ).toEqual({
    kind: 'refuse',
    message:
      'task DEV-7 was promoted from note fixture#3; compose the defect workflow with `bottega workflow compose fix-defect --mode single --project fixture --arg key=DEV-7`',
  })
})

test('allows a task with no promotion provenance', () => {
  expect(
    decidePlanTaskNoteProvenance({
      ...input,
      read: { kind: 'available', notes: [{ label: 'fixture#3', promotedTask: 'DEV-8' }] },
    }).kind,
  ).toBe('allow')
})

test('refuses when provenance cannot be read', () => {
  expect(
    decidePlanTaskNoteProvenance({
      ...input,
      read: { kind: 'unavailable', reason: 'record unavailable' },
    }),
  ).toMatchObject({ kind: 'refuse', message: expect.stringContaining('could not be read') })
})
