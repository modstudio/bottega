import { describe, expect, test } from 'bun:test'
import { REVIEW_SCHEMA, VERIFY_CLAIM_SCHEMA } from './contract/contract.ts'
import { preflight } from './dispatch/dispatch-preflight.ts'
import { JOBS } from './jobs.ts'

describe('review discipline', () => {
  test('findings jobs have stable identities and the structured coverage contract', () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      for (const name of ['review-lens', 'review-lens-inline', 'safety', 'craft']) {
        expect(JOBS[name]!.findings).toBe(true)
        expect(() => preflight(name, process.cwd())).toThrow('requires a stable lens identity')
      }
      expect(JOBS['verify-claim']!.findings).not.toBe(true)
      expect(() =>
        preflight(
          'verify-claim',
          process.cwd(),
          undefined,
          undefined,
          undefined,
          false,
          false,
          'claim',
        ),
      ).toThrow('--lens is only valid')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(REVIEW_SCHEMA.properties.provenance.required).toEqual([
      'standards_read',
      'model_used',
      'files_covered',
      'commands_run',
      'mcp_tools',
      'docs_read',
      'could_not_verify',
      'substitutes',
      'canon_source',
    ])
    expect(REVIEW_SCHEMA.properties.provenance.properties.canon_source).toBe(
      VERIFY_CLAIM_SCHEMA.properties.provenance.properties.canon_source,
    )
    expect(VERIFY_CLAIM_SCHEMA.properties.verdict.enum).toEqual(['true', 'false', 'undecidable'])
  })
})
