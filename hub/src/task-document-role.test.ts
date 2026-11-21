import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type DocumentRoleCandidate,
  documentRole,
  documentRoleRefusal,
  TASK_DOCUMENT_ROLES,
} from './task-document-role.ts'

const documents: DocumentRoleCandidate[] = [
  { id: 'holder', number: 3, role: 'handoff', title: 'Release notes', version: 'v3' },
  { id: 'other', number: 4, role: null, title: 'Other', version: 'v4' },
]

test('document role refusal names another holder and its clearing command', () => {
  expect(TASK_DOCUMENT_ROLES).toEqual(['handoff'])
  expect(documentRoleRefusal(documents, 'DEV-2563', 'handoff')).toBe(
    `role 'handoff' on task DEV-2563 is held by DEV-2563/3 "Release notes"; run \`${PLATFORM_SLUG} task doc set DEV-2563/3 --no-role --version v3\`, then retry`,
  )
  expect(documentRoleRefusal(documents, 'DEV-2563', 'handoff', 'holder')).toBeNull()
  expect(documentRole(null)).toBeNull()
  expect(() => documentRole('review')).toThrow("invalid document role 'review': expected handoff")
})
