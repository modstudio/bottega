import { expect, test } from 'bun:test'
import { docLeaveNeedsConfirmation, isDocSaveEnabled } from './edit-state.ts'

const loaded = { title: 'Install', body: 'Run it.\n' }

test('Save is enabled only when the draft is dirty and the title is valid', () => {
  expect(isDocSaveEnabled(loaded, loaded)).toBe(false)
  expect(isDocSaveEnabled(loaded, { title: 'Install', body: 'Run it now.\n' })).toBe(true)
  expect(isDocSaveEnabled(loaded, { title: 'Setup', body: loaded.body })).toBe(true)
  expect(isDocSaveEnabled(loaded, { title: '   ', body: 'Run it now.\n' })).toBe(false)
  expect(isDocSaveEnabled(loaded, { title: '', body: loaded.body })).toBe(false)
})

test('leaving asks for confirmation only when the draft is dirty', () => {
  expect(docLeaveNeedsConfirmation(loaded, loaded)).toBe(false)
  expect(docLeaveNeedsConfirmation(loaded, { title: 'Setup', body: loaded.body })).toBe(true)
  expect(docLeaveNeedsConfirmation(loaded, { title: loaded.title, body: 'Changed.\n' })).toBe(true)
  expect(docLeaveNeedsConfirmation(loaded, { title: '   ', body: loaded.body })).toBe(true)
})
