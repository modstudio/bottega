import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ISSUE_DIAGNOSIS_SCHEMA, ISSUE_WORKER_SCHEMA, JOBS, boundedIssuePack, parseFiledIssue, parseIssueReply, parseWorkerReplyWithCount, seedFromReport, validatedTrackerTaskKey } from '../test/fixture.ts'

describe('filed issue coordinator inputs', () => {
  const shown = { task: { key: 'DEV-9', title: '[DEFECT] broken', body: `TYPE: DEFECT
REPORTING SESSION: s
REPORTING PROJECT: alephbeis

WHAT HAPPENED
the command failed

EXPECTED INSTEAD
it succeeds

HOW TO REPRODUCE
Command: orch do implement x
Environment: alephbeis full seed, FORCE_COLOR=1

EVIDENCE
run 12

WHAT IS NOT ESTABLISHED
the cause` } }

  test('parses only the bounded filing fields and recognises one reported seed', () => {
    const issue = parseFiledIssue(shown)
    expect(issue).toMatchObject({ key: 'DEV-9', reportingProject: 'alephbeis',
      reproduceCommand: 'orch do implement x', environment: 'alephbeis full seed, FORCE_COLOR=1' })
    const project = { id: 1, name: 'alephbeis', path: '/x', stack: null, canon: true,
      settings: { worktree: { seeds: ['none', 'minimal', 'full'] } } } as any
    expect(seedFromReport(project, issue.environment)).toBe('full')
    expect(Object.keys(JSON.parse(boundedIssuePack(issue)))).toEqual([
      'key', 'title', 'kind', 'reporting_project', 'what_happened', 'expected',
      'reproduce_command', 'environment', 'evidence', 'not_established',
    ])
  })

  test('does not choose between absent or ambiguous seeds', () => {
    const project = { settings: { worktree: { seeds: ['none', 'full'] } } } as any
    expect(seedFromReport(project, 'ordinary shell')).toBeNull()
    expect(seedFromReport(project, 'compare none with full')).toBeNull()
  })

  test('the issue path consumes its chosen seed only for the writing fix run', () => {
    const source = readFileSync(new URL('./issue.ts', import.meta.url), 'utf8')
    const diagnosis = source.slice(
      source.indexOf('diagnosisRun = await run({'),
      source.indexOf('const diagnosis =', source.indexOf('diagnosisRun = await run({')),
    )
    const fix = source.slice(
      source.indexOf('fixRun = await run({'),
      source.indexOf('const fix =', source.indexOf('fixRun = await run({')),
    )
    const lens = source.slice(
      source.indexOf('const lens ='),
      source.indexOf('const review =', source.indexOf('const lens =')),
    )
    expect(diagnosis).toContain("job: 'diagnose'")
    expect(diagnosis).not.toContain('seed:')
    expect(fix).toContain("job: 'issue-worker'")
    expect(fix).toContain('seed: fixSeed ?? undefined')
    expect(lens).toContain("job: 'review-lens'")
    expect(lens).not.toContain('seed:')
  })

  test('validates tracker-new stdout with the target project key standard', () => {
    const project = { settings: { worktree: { keyPattern: '^AB-[1-9][0-9]*$' } } } as any
    expect(validatedTrackerTaskKey('AB-42', project)).toBe('AB-42')
    expect(() => validatedTrackerTaskKey('', project))
      .toThrow('hub task tracker-new did not return a valid task key; returned ""')
    expect(() => validatedTrackerTaskKey('created task AB-42', project))
      .toThrow('hub task tracker-new did not return a valid task key; returned "created task AB-42"')
  })

  test('takes the last structured diagnosis and requires what could not be established', () => {
    const reply = {
      status: 'done', outcome: 'not-a-defect', cause_location: 'project-tool',
      cause_matched_report: false, established_cause: 'documented refusal',
      target_project: 'alephbeis', proposed_fix: null, register_change: null,
      reproduction: { command: 'x', base_commit: 'abc', environment: 'full', seed: 'full' },
      before: 'exit 2', after: null, questions: null, not_established: 'whether the caller expected another contract',
      blockers: null,
    }
    expect(parseIssueReply<any>(`narration {"status":"done"}\n${JSON.stringify(reply)}`,
      ISSUE_DIAGNOSIS_SCHEMA)).toEqual(reply)
    const { not_established: _, ...missing } = reply
    expect(() => parseIssueReply(JSON.stringify(missing), ISSUE_DIAGNOSIS_SCHEMA)).toThrow('structured contract')
  })

  test('the routed issue worker has a distinct accepted writing contract', () => {
    const reply = {
      status: 'done', outcome: 'fixed', cause_location: 'orch-code', cause_matched_report: true,
      established_cause: 'bad branch comparison',
      reproduction: { command: 'bun test', base_commit: 'abc', environment: 'worker', seed: null },
      before: '1 failed', after: '0 failed', plain_gate: 'passed', worker_gate: 'passed',
      blast_radius: 'the one caller', branch: 'DEV-9-orch-1', files_changed: ['src/a.ts'],
      questions: null, not_established: '', blockers: null, summary: 'fixed', deviations: null,
      tests: { command: 'bun test', ran: true, passed: true, detail: '1 test' },
    }
    expect(parseWorkerReplyWithCount(JSON.stringify(reply), ISSUE_WORKER_SCHEMA).reply).toEqual(reply as any)
    expect(JOBS['issue-worker']!.needs).toEqual({ readsRepo: true, writesRepo: true, resumable: true })
  })
})
