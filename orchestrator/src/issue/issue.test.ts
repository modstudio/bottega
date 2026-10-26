import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ISSUE_WORKER_SCHEMA, type IssueWorkerReply } from '../contract/contract.ts'
import { parseWorkerReplyWithCount } from '../contract/contract-reply.ts'
import { JOBS } from '../jobs/jobs.ts'
import type { Project } from '../project/projects.ts'
import {
  diagnosisPrompt,
  fixPrompt,
  fixSeedRequired,
  ISSUE_DIAGNOSIS_SCHEMA,
  issueReproductionCommand,
  measureIssueBefore,
  parseIssueReply,
  priorIssueRecord,
  requestText,
  resolvedSeed,
  validatedTrackerTaskKey,
} from './issue.ts'
import type { FiledIssue } from './issue-file.ts'
import {
  fixVerificationResumeLine,
  issueFailureResumeLine,
  issueResumeLine,
} from './issue-resume.ts'

describe('filed issue coordinator inputs', () => {
  test('diagnosis and fix prompts define the executable reproduction contract', () => {
    const issue = {
      reportingProject: PLATFORM_SLUG,
    } as FiledIssue
    const contract =
      'one shell command, run from the repository root of the project it names, that exits nonzero while the defect is present and zero once it is fixed'
    expect(diagnosisPrompt(issue, '')).toContain(contract)
    expect(fixPrompt(issue, {} as never)).toContain(contract)
  })

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
      `Answer with: ${PLATFORM_SLUG} task comment DEV-9 "Seed: <one of the options>"`,
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

  test('a configured writing tree requires one of its own seeds', () => {
    expect(fixSeedRequired(['none', 'full'], null)).toBe(true)
    expect(fixSeedRequired(['none', 'full'], 'full')).toBe(false)
    expect(fixSeedRequired([], null)).toBe(false)
  })

  test('fix seed answers are resolved against the target project', () => {
    const target = {
      settings: { worktree: { seeds: ['target-none', 'target-full'] } },
    } as unknown as Project
    expect(resolvedSeed(target, 'target-full environment', [])).toBe('target-full')
    expect(resolvedSeed(target, null, ['Seed: reporting-full', 'Seed: target-none'])).toBe(
      'target-none',
    )
  })

  test('a fixed-branch handback ships the existing run while coordinator failure restarts', () => {
    expect(
      issueResumeLine('DEV-9', {
        runNumber: 42,
        target: 'starship',
        branchKey: 'STAR-7',
        branch: 'STAR-7-fix',
      }),
    ).toBe(
      `Resume with: ${PLATFORM_SLUG} tree open 42, then ${PLATFORM_SLUG} workflow compose ship-task --project starship --mode merge --arg key=STAR-7 --arg branch=STAR-7-fix --arg worktree=<path tree open prints>`,
    )
    expect(issueResumeLine('DEV-9')).toBe(`Resume with: ${PLATFORM_SLUG} workflow fix-defect DEV-9`)
  })

  test('coordinator failure preserves a recorded fix branch when it can be reopened', () => {
    expect(
      issueFailureResumeLine({
        issueKey: 'DEV-9',
        fixRunNumber: 42,
        failedRunNumber: null,
        target: 'starship',
        branchKey: 'STAR-7',
        branch: 'STAR-7-fix',
      }),
    ).toContain(`${PLATFORM_SLUG} tree open 42`)
    expect(
      issueFailureResumeLine({
        issueKey: 'DEV-9',
        fixRunNumber: null,
        failedRunNumber: null,
        target: null,
        branchKey: null,
        branch: null,
      }),
    ).toBe(issueResumeLine('DEV-9'))
  })

  test('reproduction command prefers the fix reply and falls back only to diagnosis', () => {
    const reply = (command: string) => ({ reproduction: { command } })
    expect(issueReproductionCommand(reply(' bun test fix '), reply('bun test diagnosis'))).toBe(
      'bun test fix',
    )
    expect(issueReproductionCommand(reply('   '), reply(' bun test diagnosis '))).toBe(
      'bun test diagnosis',
    )
    expect(issueReproductionCommand(reply(''), reply('   '))).toBe('')
  })

  test('cross-project before measurement releases its owned checkout when measurement throws', async () => {
    const released: string[] = []
    const created: { target: Project; base: string }[] = []
    const reporting = { name: 'reporting' } as Project
    const target = { name: 'target' } as Project
    await expect(
      measureIssueBefore(
        {
          command: 'bun test',
          diagnosisRun: { record_id: 'diagnosis' } as never,
          fixRun: {
            record_id: 'fix',
            worktree: { path: '/fix', repoRoot: '/target', branch: 'DEV-1', base: 'base' },
          } as never,
          reporting,
          target,
          sandboxHome: '/sandbox',
        },
        {
          createTree: (createdTarget, base) => {
            created.push({ target: createdTarget, base })
            return {
              runId: 'before-run',
              worktree: { path: '/before', repoRoot: '/target', branch: '', base: 'base' },
            }
          },
          measure: async () => {
            throw new Error('measurement exploded')
          },
          releaseTree: async (runId) => {
            released.push(runId)
            return null
          },
        },
      ),
    ).rejects.toThrow('measurement exploded')
    expect(created).toEqual([{ target, base: 'base' }])
    expect(released).toEqual(['before-run'])
  })

  test('cross-project before measurement refuses proof when checkout release fails', async () => {
    const created: { target: Project; base: string }[] = []
    const reporting = { name: 'reporting' } as Project
    const target = { name: 'target' } as Project
    await expect(
      measureIssueBefore(
        {
          command: 'bun test',
          diagnosisRun: { record_id: 'diagnosis' } as never,
          fixRun: {
            record_id: 'fix',
            worktree: { path: '/fix', repoRoot: '/target', branch: 'DEV-1', base: 'base' },
          } as never,
          reporting,
          target,
          sandboxHome: '/sandbox',
        },
        {
          createTree: (createdTarget, base) => {
            created.push({ target: createdTarget, base })
            return {
              runId: 'before-run',
              worktree: { path: '/before', repoRoot: '/target', branch: '', base: 'base' },
            }
          },
          measure: async () => ({ ok: false, text: 'failed as expected', exitCode: 1 }),
          releaseTree: async () => 'run before-run: removal refused',
        },
      ),
    ).rejects.toThrow(
      'could not release before-measurement checkout for run before-run; the checkout is retained: run before-run: removal refused',
    )
    expect(created).toEqual([{ target, base: 'base' }])
  })

  test('same-project before measurement uses the diagnosis tree without creating a checkout', async () => {
    const project = { name: 'reporting' } as Project
    const measured: string[] = []
    let createCalled = false
    const result = await measureIssueBefore(
      {
        command: 'bun test',
        diagnosisRun: { worktree: { path: '/diagnosis' } } as never,
        fixRun: {
          worktree: { path: '/fix', repoRoot: '/reporting', branch: 'DEV-1', base: 'base' },
        } as never,
        reporting: project,
        target: project,
        sandboxHome: '/sandbox',
      },
      {
        createTree: () => {
          createCalled = true
          throw new Error('must not create a same-project before checkout')
        },
        measure: async (_command, cwd) => {
          measured.push(cwd)
          return { ok: false, text: 'defect reproduced', exitCode: 1 }
        },
      },
    )

    expect(createCalled).toBe(false)
    expect(measured).toEqual(['/diagnosis'])
    expect(result.exitCode).toBe(1)
  })

  test('verification resume selection preserves the fix branch only on handback', () => {
    const input = {
      issueKey: 'DEV-9',
      fixRun: { number: 42, worktree: { branch: 'STAR-7-fix' } },
      fix: { branch: 'reply-branch' },
      target: { name: 'starship' },
      branchKey: 'STAR-7',
    } as unknown as Omit<Parameters<typeof fixVerificationResumeLine>[0], 'ready'>
    expect(fixVerificationResumeLine({ ...input, ready: true })).toBeUndefined()
    expect(fixVerificationResumeLine({ ...input, ready: false })).toBe(
      `Resume with: ${PLATFORM_SLUG} tree open 42, then ${PLATFORM_SLUG} workflow compose ship-task --project starship --mode merge --arg key=STAR-7 --arg branch=STAR-7-fix --arg worktree=<path tree open prints>`,
    )
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
      `${PLATFORM_SLUG} task tracker-new did not return a valid task key; returned ""`,
    )
    expect(() => validatedTrackerTaskKey('created task AB-42', project)).toThrow(
      `${PLATFORM_SLUG} task tracker-new did not return a valid task key; returned "created task AB-42"`,
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
      change_guide: [
        {
          files: ['src/a.ts'],
          explanation: 'Fixes the branch comparison.',
          verify: 'The corrected comparison.',
        },
      ],
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
