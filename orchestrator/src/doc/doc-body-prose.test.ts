import { expect, test } from 'bun:test'
import { SETTINGS_SCOPE } from '../settings/settings.ts'
import { docBodyIsProse, docProseFields } from './doc-body-prose.ts'

test('only settings documents have structured non-prose bodies', () => {
  expect(docBodyIsProse(SETTINGS_SCOPE)).toBe(false)
  expect(docBodyIsProse('canon')).toBe(true)
  expect(docBodyIsProse('project')).toBe(true)
})

test('document prose fields include structured metadata and only prose bodies', () => {
  const prior = { title: 'Old title', summary: 'Old summary', body: 'Old body' }
  const input = { title: 'New title', summary: 'New summary', body: 'New body' }
  expect(docProseFields({ ...input, scope: 'project' }, prior)).toEqual([
    { field: 'title', text: 'New title', prior: 'Old title' },
    { field: 'summary', text: 'New summary', prior: 'Old summary' },
    { field: 'body', text: 'New body', prior: 'Old body' },
  ])
  expect(docProseFields({ ...input, scope: SETTINGS_SCOPE }, prior)).toEqual([
    { field: 'title', text: 'New title', prior: 'Old title' },
    { field: 'summary', text: 'New summary', prior: 'Old summary' },
  ])
})
