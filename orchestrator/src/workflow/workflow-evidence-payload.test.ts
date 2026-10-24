import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  encodeWorkflowEvidencePayload,
  parseWorkflowEvidencePayload,
  type WorkflowEvidencePayload,
} from './workflow-evidence-payload.ts'

const payload: WorkflowEvidencePayload = {
  command: [PLATFORM_SLUG, 'machine', 'update'],
  cwd: '/checkout',
  exitCode: 3,
  signal: null,
  output: 'pulled 4 commits\n',
  headCommit: 'a'.repeat(40),
  preCommandHeadCommit: 'b'.repeat(40),
}

describe('workflow evidence payload', () => {
  test('round trips every declared field', () => {
    const killed: WorkflowEvidencePayload = {
      ...payload,
      exitCode: -1,
      signal: 'SIGTERM',
      headCommit: null,
      preCommandHeadCommit: null,
    }
    for (const shape of [payload, killed])
      expect(parseWorkflowEvidencePayload(encodeWorkflowEvidencePayload(shape))).toEqual(shape)
  })

  test('refuses a payload whose argv is not an array of strings', () => {
    expect(() =>
      parseWorkflowEvidencePayload(JSON.stringify({ ...payload, command: 'machine update' })),
    ).toThrow('command must be a non-empty array of strings')
    expect(() =>
      parseWorkflowEvidencePayload(JSON.stringify({ ...payload, command: ['update', 7] })),
    ).toThrow('command must be a non-empty array of strings')
  })
})
