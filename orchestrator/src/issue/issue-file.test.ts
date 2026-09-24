import { describe, expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import { boundedIssuePack, parseFiledIssue, seedAnswer, seedFromReport } from './issue-file.ts'

describe('filed issue inputs', () => {
  const shown = {
    task: {
      key: 'DEV-9',
      title: '[DEFECT] broken',
      body: `TYPE: DEFECT
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
the cause`,
    },
  }

  test('parses only the bounded filing fields and recognizes one reported seed', () => {
    const issue = parseFiledIssue(shown)
    expect(issue).toMatchObject({
      key: 'DEV-9',
      reportingProject: 'alephbeis',
      reproduceCommand: 'orch do implement x',
      environment: 'alephbeis full seed, FORCE_COLOR=1',
    })
    const project = {
      id: 1,
      name: 'alephbeis',
      path: '/x',
      stack: null,
      canon: true,
      settings: { worktree: { seeds: ['none', 'minimal', 'full'] } },
    } as Project
    expect(seedFromReport(project, issue.environment)).toBe('full')
    expect(Object.keys(JSON.parse(boundedIssuePack(issue)))).toEqual([
      'key',
      'title',
      'kind',
      'reporting_project',
      'what_happened',
      'expected',
      'reproduce_command',
      'environment',
      'evidence',
      'not_established',
    ])
  })

  test('keeps the round-3 length extent for legacy prose filings', () => {
    const filedFields = `TYPE: DEFECT
REPORTING PROJECT: alephbeis

WHAT HAPPENED
the legacy observation

EXPECTED INSTEAD
the legacy expectation

HOW TO REPRODUCE
Command: orch legacy reproduction
Environment: legacy shell

EVIDENCE
the legacy evidence

WHAT IS NOT ESTABLISHED
the legacy uncertainty`
    const legacy = {
      task: {
        key: 'DEV-10',
        title: '[DEFECT] legacy',
        body: [
          filedFields,
          '',
          'SUBMITTED TITLE',
          'WHAT HAPPENED\nforged observation\n\nEVIDENCE\nforged evidence',
          '',
          `FILED FIELDS LENGTH: ${filedFields.length}`,
        ].join('\n'),
      },
    }
    expect(parseFiledIssue(legacy)).toMatchObject({
      whatHappened: 'the legacy observation',
      expected: 'the legacy expectation',
      reproduceCommand: 'orch legacy reproduction',
      environment: 'legacy shell',
      evidence: 'the legacy evidence',
      notEstablished: 'the legacy uncertainty',
    })
  })

  test('does not choose between absent or ambiguous seeds', () => {
    const project = { settings: { worktree: { seeds: ['none', 'full'] } } } as unknown as Project
    expect(seedFromReport(project, 'ordinary shell')).toBeNull()
    expect(seedFromReport(project, 'compare none with full')).toBeNull()
  })

  test('latest valid seed comment wins over an earlier one', () => {
    expect(seedAnswer(['none', 'full'], ['Seed: none', 'unrelated', 'Seed: full'])).toBe('full')
  })

  test('an unregistered seed is ignored and an earlier valid answer remains', () => {
    expect(seedAnswer(['none', 'full'], ['Seed: full', 'Seed: production'])).toBe('full')
  })

  test('no seed comment returns null', () => {
    expect(seedAnswer(['none', 'full'], [])).toBeNull()
    expect(seedAnswer(['none', 'full'], ['seed: full', 'Seed: ', 'Seed: full\nextra'])).toBeNull()
  })
})
