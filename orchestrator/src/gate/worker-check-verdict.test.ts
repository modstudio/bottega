import { describe, expect, test } from 'bun:test'
import {
  decideWorkerCheckVerdict,
  type WorkerCheckCandidate,
  workerCheckFailures,
  workerCheckRefusalText,
} from './worker-check-verdict.ts'

const head = '1234567890abcdef1234567890abcdef12345678'

function check(overrides: Partial<WorkerCheckCandidate> = {}): WorkerCheckCandidate {
  return {
    recordId: '01990000-0000-7000-8000-000000000001',
    number: 41,
    headCommit: head,
    requestedAt: '2026-11-20T10:00:00.000Z',
    exitCode: 0,
    timedOut: false,
    failures: [],
    ...overrides,
  }
}

describe('worker check verdict at the reply HEAD', () => {
  test('refuses a done reply when the latest check failed and names each recorded leg tail', () => {
    const verdict = decideWorkerCheckVerdict(
      head,
      check({
        exitCode: 1,
        failures: [
          { leg: 'orchestrator', tail: ['src/example.test.ts(79,5): error TS2322'] },
          { leg: 'scripts', tail: ['check failed'] },
        ],
      }),
    )

    expect(workerCheckRefusalText(verdict)).toBe(
      [
        'worker check: FAILED at 1234567890ab (gate 41): orchestrator, scripts. A done reply is refused because its recorded worker check failed.',
        'orchestrator:',
        '  src/example.test.ts(79,5): error TS2322',
        'scripts:',
        '  check failed',
        'The reply cannot be done until the worker check passes at this HEAD, or the worker stops and asks.',
      ].join('\n'),
    )
  })

  test('passes a done reply when the check passed', () => {
    const verdict = decideWorkerCheckVerdict(head, check())
    expect(workerCheckRefusalText(verdict)).toBeNull()
    expect(verdict.kind).toBe('passed')
  })

  test('passes with none when the only check is at another HEAD', () => {
    const verdict = decideWorkerCheckVerdict(head, check({ headCommit: 'f'.repeat(40) }))
    expect(workerCheckRefusalText(verdict)).toBeNull()
    expect(verdict.kind).toBe('none')
  })
})

test('failure detail comes from the recorded gate footer for known failing legs', () => {
  expect(
    workerCheckFailures(
      [
        '[orchestrator] failing leg tail (exit 2)',
        '[orchestrator] raw typecheck tail',
        'gate failures:',
        'orchestrator',
        '  src/example.test.ts(79,5): error TS2322',
        'scripts',
        '  scripts/check.ts failed',
        'script "check:worker" exited with code 1',
      ].join('\n'),
      ['orchestrator', 'scripts'],
    ),
  ).toEqual([
    { leg: 'orchestrator', tail: ['[orchestrator] raw typecheck tail'] },
    { leg: 'scripts', tail: ['scripts/check.ts failed'] },
  ])
})
