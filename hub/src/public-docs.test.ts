import { expect, test } from 'bun:test'
import { publicDoc, publicDocSearch, publicDocsTree } from './public-docs.ts'

test('public doc helpers accept only the record-route inputs', () => {
  expect(publicDocsTree.length).toBe(0)
  expect(publicDoc.length).toBe(1)
  expect(publicDocSearch.length).toBe(1)
})
