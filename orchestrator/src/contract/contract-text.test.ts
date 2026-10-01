import { describe, expect, test } from 'bun:test'
import { JOBS, jobBoundInstructionForContract } from '../jobs/jobs.ts'
import {
  COULD_NOT_VERIFY_INSTRUCTION,
  contractConflicts,
  INFRASTRUCTURE_RECOVERY,
  NO_REPO_PREAMBLE,
  READER_DELIVERABLE_FIRST,
  READONLY_PREAMBLE,
  REVIEW_PROVENANCE_INSTRUCTION,
  REVIEW_SCHEMA,
  REVIEW_SEVERITY_INSTRUCTION,
  WORKER_PREAMBLE,
} from './contract.ts'
import { contractText } from './contract-text.ts'

describe('job contracts are visible before submission', () => {
  const contract = (jobName: string) => {
    try {
      return { code: 0, out: contractText(jobName), err: '' }
    } catch (cause) {
      return { code: 1, out: '', err: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  test('the read-only contract names inherited work without claiming it is always present', () => {
    expect(READONLY_PREAMBLE).toContain('fresh checkout of this')
    expect(READONLY_PREAMBLE).toContain("run's commit to read")
    expect(READONLY_PREAMBLE).not.toContain("run's base commit")
    expect(READONLY_PREAMBLE).toContain(
      'If the caller chose to carry their uncommitted work into it',
    )
    expect(READONLY_PREAMBLE).toContain('do not report it as your change')
    expect(READONLY_PREAMBLE).not.toContain("It contains the caller's")
    expect(READONLY_PREAMBLE).toContain(
      'Edit and test freely when that helps you verify a finding. Your findings are the\n' +
        'deliverable, not your diff: every change you make here is scratch work and must\n' +
        'never be treated as a proposed change to land. Do not commit, push, or merge.',
    )
  })
  test('reader contracts require the deliverable before ceiling-vulnerable reasoning', () => {
    expect(READONLY_PREAMBLE).toContain(READER_DELIVERABLE_FIRST)
    expect(NO_REPO_PREAMBLE).toContain(READER_DELIVERABLE_FIRST)
  })
  test('diagnose and review-lens require partial delivery around blocked sub-questions', () => {
    for (const name of ['diagnose', 'review-lens']) {
      const r = contract(name)
      expect(r.code).toBe(0)
      const text = r.out.replace(/\s+/g, ' ')
      expect(text).toContain('A prompt with several questions is not atomic')
      expect(text).toContain('report BLOCKED under that question')
      expect(text).toContain('Never withhold deliverable answers behind a blocked one')
      expect(text).toContain('could_not_verify for that sub-question')
    }
  })
  test('repository readers and writers receive the same infrastructure recovery paragraph', () => {
    expect(READONLY_PREAMBLE).toContain(INFRASTRUCTURE_RECOVERY)
    expect(WORKER_PREAMBLE).toContain(INFRASTRUCTURE_RECOVERY)
    expect(READONLY_PREAMBLE.match(/PROJECT INFRASTRUCTURE RECOVERY/g)).toHaveLength(1)
    expect(WORKER_PREAMBLE.match(/PROJECT INFRASTRUCTURE RECOVERY/g)).toHaveLength(1)
    expect(INFRASTRUCTURE_RECOVERY).toContain('worktree.recipe.serve')
    expect(INFRASTRUCTURE_RECOVERY).toContain('worktree.notes')
    expect(INFRASTRUCTURE_RECOVERY).toContain(
      'A reader MAY run that serve step and MAY make scratch edits to verify a finding; a reader MUST NOT commit, and its diff is never the deliverable.',
    )
  })
  test('review provenance makes an unexecuted suite visible', () => {
    const paragraphInstruction = INFRASTRUCTURE_RECOVERY.split('\n\n').at(-1)!
    const schemaInstruction: string =
      REVIEW_SCHEMA.properties.provenance.properties.could_not_verify.description
    expect(paragraphInstruction).toBe(COULD_NOT_VERIFY_INSTRUCTION)
    expect(schemaInstruction).toBe(paragraphInstruction)
  })
  test('review contract prose names every provenance list dropped with schema binding', () => {
    const text = contract('review-lens').out.replace(/\s+/g, ' ')
    expect(text).toContain(REVIEW_PROVENANCE_INSTRUCTION)
    expect(text).toContain('provenance.mcp_tools')
    expect(text).toContain('provenance.docs_read')
    expect(text).toContain('provenance.substitutes')
    expect(text).toContain('Empty arrays are valid')
    expect(text).toContain('<server>.<tool>')
  })
  test('writing and reading workers file findings instead of leaving only mailbox notes', () => {
    for (const preamble of [WORKER_PREAMBLE, READONLY_PREAMBLE]) {
      expect(preamble).toContain('file_issue')
      expect(preamble).toContain('OUTSIDE')
      expect(preamble).toContain('do not leave it only as')
      expect(preamble).toContain('a mailbox note')
    }
  })
  test('writers run the registered gate while readers inspect its recorded result', () => {
    expect(WORKER_PREAMBLE).toContain('When the `run_gate` tool is available')
    expect(WORKER_PREAMBLE).toContain("reply's tests section")
    expect(READONLY_PREAMBLE).not.toContain('run_gate')
    expect(READONLY_PREAMBLE).toContain('Call `gate_result`')
    expect(READONLY_PREAMBLE).toContain('Never\nrun Docker or `scripts/gate` yourself')
    expect(READONLY_PREAMBLE).toContain('`could_not_verify`')
    expect(NO_REPO_PREAMBLE).not.toContain('run_gate')
  })
  test('contract prints the same preamble selected when a job is bound', () => {
    for (const [name, definition] of Object.entries(JOBS)) {
      const r = contract(name)
      expect(r.code).toBe(0)
      expect(r.out).toBe(
        `${definition.findings ? `${REVIEW_SEVERITY_INSTRUCTION}\n\n` : ''}${
          definition.needs.writesRepo
            ? WORKER_PREAMBLE
            : definition.needs.readsRepo
              ? READONLY_PREAMBLE
              : NO_REPO_PREAMBLE
        }\n\n` + `${jobBoundInstructionForContract(definition)}\n`,
      )
      expect(r.err).toBe('')
    }
  }, 20_000)
  test('contract rejects an unknown job', () => {
    const r = contract('not-a-job')
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown job "not-a-job"')
  })
  test('implement conflict warnings identify the original line', () => {
    const spec = [
      'Make the requested change.',
      'Commit it using the DEV-126 prefix.',
      'Then push the branch.',
    ].join('\n')
    expect(contractConflicts(spec)).toEqual([{ line: 3, text: 'Then push the branch.' }])
  })
})
