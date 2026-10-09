import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ISSUE_WORKER_SCHEMA,
  type IssueWorkerReply,
  parseWorkerReplyWithCount,
} from '../contract/contract.ts'
import { JOBS } from '../jobs/jobs.ts'
import type { Project } from '../project/projects.ts'
import {
  ISSUE_DIAGNOSIS_SCHEMA,
  parseIssueReply,
  priorIssueRecord,
  requestText,
  validatedTrackerTaskKey,
} from './issue.ts'
import type { FiledIssue } from './issue-file.ts'

describe('filed issue coordinator inputs', () => {
  test('includes a UUID-addressed handoff in the prior issue record', async () => {
    const id = '01990000-0000-7000-8000-000000001214'
    const requested: string[] = []
    const record = await priorIssueRecord(
      { comments: [{ body: 'Earlier comment' }], documents: [{ id, role: 'handoff' }] },
      async (documentId) => {
        requested.push(documentId)
        return JSON.stringify({ body: 'Binding handoff ruling' })
      },
    )
    expect(requested).toEqual([id])
    expect(record).toBe('Earlier comment\n\n---\n\nBinding handoff ruling')
  })

  test('seed request names the task-comment command that records the answer', () => {
    const issue = {
      key: 'DEV-9',
      notEstablished: 'the cause',
    } as FiledIssue
    expect(requestText(issue, 'Which seed?', ['none', 'full'], 'none', 'worktree')).toContain(
      'Answer with: hub task comment DEV-9 "Seed: <one of the options>"',
    )
  })

  test('seed request reports an unregistered answer with the registered options', () => {
    const issue = {
      key: 'DEV-9',
      notEstablished: 'the cause',
    } as FiledIssue
    expect(
      requestText(issue, 'Which seed?', ['none', 'full'], 'none', 'worktree', 'production'),
    ).toContain('Rejected seed: production; registered options: none | full')
  })

  test('the issue path consumes its chosen seed only for the writing fix run', () => {
    const source = readFileSync(new URL('./issue.ts', import.meta.url), 'utf8')
    const reviewSource = readFileSync(new URL('./issue-review-run.ts', import.meta.url), 'utf8')
    const diagnosis = source.slice(
      source.indexOf('diagnosisRun = await run({'),
      source.indexOf('const diagnosis =', source.indexOf('diagnosisRun = await run({')),
    )
    const fix = source.slice(
      source.indexOf('fixRun = await run({'),
      source.indexOf('const fix =', source.indexOf('fixRun = await run({')),
    )
    const lens = reviewSource.slice(
      reviewSource.indexOf("runId = await detach('review-lens'"),
      reviewSource.indexOf('const dispatchNext = await waitUntilRoutingCounts(runId)'),
    )
    expect(diagnosis).toContain("job: 'diagnose'")
    expect(diagnosis).not.toContain('seed:')
    expect(fix).toContain("job: 'issue-worker'")
    expect(fix).toContain('seed: fixSeed ?? undefined')
    expect(lens).toContain("detach('review-lens'")
    expect(lens).toContain('review: worktree.branch')
    expect(lens).not.toContain('seed:')
  })

  test('validates tracker-new stdout with the target project key standard', () => {
    const project = {
      settings: { worktree: { keyPattern: '^AB-[1-9][0-9]*$' } },
    } as unknown as Project
    expect(validatedTrackerTaskKey('AB-42', project)).toBe('AB-42')
    expect(() => validatedTrackerTaskKey('', project)).toThrow(
      'hub task tracker-new did not return a valid task key; returned ""',
    )
    expect(() => validatedTrackerTaskKey('created task AB-42', project)).toThrow(
      'hub task tracker-new did not return a valid task key; returned "created task AB-42"',
    )
  })

  test('takes the last structured diagnosis and requires what could not be established', () => {
    const reply = {
      status: 'done',
      outcome: 'not-a-defect',
      cause_location: 'project-tool',
      cause_matched_report: false,
      established_cause: 'documented refusal',
      target_project: 'alephbeis',
      proposed_fix: null,
      register_change: null,
      reproduction: { command: 'x', base_commit: 'abc', environment: 'full', seed: 'full' },
      before: 'exit 2',
      after: null,
      questions: null,
      not_established: 'whether the caller expected another contract',
      blockers: null,
    }
    expect(
      parseIssueReply<typeof reply>(
        `narration {"status":"done"}\n${JSON.stringify(reply)}`,
        ISSUE_DIAGNOSIS_SCHEMA,
      ),
    ).toEqual(reply)
    const { not_established: _, ...missing } = reply
    expect(() => parseIssueReply(JSON.stringify(missing), ISSUE_DIAGNOSIS_SCHEMA)).toThrow(
      'structured contract',
    )
  })

  test('the routed issue worker has a distinct accepted writing contract', () => {
    const reply: IssueWorkerReply = {
      status: 'done',
      outcome: 'fixed',
      cause_location: 'orch-code',
      cause_matched_report: true,
      established_cause: 'bad branch comparison',
      reproduction: { command: 'bun test', base_commit: 'abc', environment: 'worker', seed: null },
      before: '1 failed',
      after: '0 failed',
      plain_gate: 'passed',
      worker_gate: 'passed',
      blast_radius: 'the one caller',
      branch: 'DEV-9-orch-1',
      files_changed: ['src/a.ts'],
      questions: null,
      not_established: '',
      blockers: null,
      summary: 'fixed',
      deviations: null,
      tests: { command: 'bun test', ran: true, passed: true, detail: '1 test' },
    }
    expect(parseWorkerReplyWithCount(JSON.stringify(reply), ISSUE_WORKER_SCHEMA).reply).toEqual(
      reply,
    )
    expect(JOBS['issue-worker']!.needs).toEqual({
      readsRepo: true,
      writesRepo: true,
      resumable: true,
    })
  })
})
