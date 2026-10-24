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

/** The repository's named fake fixture credential: it is secret-shaped and allowed by .gitleaks.toml. */
const SECRET = 'ghp_123456789012345678901234567890123456'

const refusalOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the payload to be refused')
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

  test('refuses a payload missing its exit code', () => {
    const { exitCode, ...missing } = payload
    expect(exitCode).toBe(3)
    expect(() => parseWorkflowEvidencePayload(JSON.stringify(missing))).toThrow(
      'exitCode must be an integer',
    )
  })

  test('refuses a payload whose argv is not an array of strings', () => {
    expect(() =>
      parseWorkflowEvidencePayload(JSON.stringify({ ...payload, command: 'machine update' })),
    ).toThrow('command must be a non-empty array of strings')
    expect(() =>
      parseWorkflowEvidencePayload(JSON.stringify({ ...payload, command: ['update', 7] })),
    ).toThrow('command must be a non-empty array of strings')
  })

  test('refuses text that is not a payload', () => {
    expect(() => parseWorkflowEvidencePayload('not json')).toThrow('it is not JSON')
    expect(() => parseWorkflowEvidencePayload('[]')).toThrow('the payload must be an object')
  })

  /**
   * No redaction has run on a payload a refusal rejects, so the refusal may name only the
   * field and the reason: a parse error's own message quotes the input, and the output a
   * payload carries is raw.
   */
  test('a refusal never repeats the payload text', () => {
    const notJson = refusalOf(() => parseWorkflowEvidencePayload(SECRET))
    expect(notJson).toContain('it is not JSON')
    expect(notJson).not.toContain(SECRET)

    const { exitCode, ...missing } = { ...payload, output: `token=${SECRET}\n` }
    expect(exitCode).toBe(3)
    const byField = refusalOf(() => parseWorkflowEvidencePayload(JSON.stringify(missing)))
    expect(byField).toContain('exitCode must be an integer')
    expect(byField).not.toContain(SECRET)
    expect(byField).not.toContain('token=')
  })
})
