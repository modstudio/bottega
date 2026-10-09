import { expect, test } from 'bun:test'
import { formatTaskDocumentLabel, parseTaskDocumentLabel } from './task-document-label.ts'

test('task document labels round trip', () => {
  const label = formatTaskDocumentLabel('dev-1208', 3)
  expect(label).toBe('DEV-1208/3')
  expect(parseTaskDocumentLabel(label)).toEqual({ taskKey: 'DEV-1208', number: 3 })
})

test('task document labels refuse bare integers and malformed labels', () => {
  expect(() => parseTaskDocumentLabel('3')).toThrow(
    'expected label <KEY>/<number> or a document UUID; run `hub task doc list <KEY>`',
  )
  expect(() => parseTaskDocumentLabel('DEV-1208/no')).toThrow(
    'expected label DEV-1208/<number> or a document UUID; run `hub task doc list DEV-1208`',
  )
})
