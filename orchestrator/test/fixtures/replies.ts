import { OrchRunEnvelopeSchema } from '../../../shared/orch-contract.ts'

type RunJson = Record<string, unknown> & {
  id: number
  turns: { id: number; vendor_tokens: number }[]
  questions: { answered_at: string | null }[]
  launch_key: string | null
  evidence_excluded: string | null
}

export const runJson = (line: string) =>
  OrchRunEnvelopeSchema.parse(JSON.parse(line)).data as RunJson

export const reviewReply = (findings = 1, severity = 'major') => ({
  findings: Array.from({ length: findings }, (_, i) => ({
    severity,
    location: `file.ts:${i + 1}`,
    evidence: `evidence ${i + 1}`,
    proposed_correction: `fix ${i + 1}`,
  })),
  provenance: {
    tree_inspected: 'abc123',
    standards_read: ['AGENTS.md'],
    model_used: 'reported-by-reviewer',
    files_covered: ['file.ts'],
    commands_run: ['bun test'],
    mcp_tools: [],
    docs_read: [],
    could_not_verify: [],
    substitutes: [],
    canon_source: 'live database' as const,
  },
})

export function workerReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'done',
    summary: 'done',
    files_changed: ['changed.ts'],
    questions: null,
    deviations: null,
    tests: { command: 'bun test', ran: true, passed: true, detail: null },
    blockers: null,
    ...overrides,
  }
}
