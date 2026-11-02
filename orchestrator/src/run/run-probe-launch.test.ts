import { expect, mock, spyOn, test } from 'bun:test'
import { AGENTS } from '../agent/agent-registry.ts'
import { job } from '../jobs/jobs.ts'
import {
  prepareRunProbeLaunch,
  probeReaderFindings,
  reportProbeOverrides,
} from './run-probe-launch.ts'

test('a context override refuses a non-Goose failover launch', () => {
  const launch = prepareRunProbeLaunch(
    AGENTS.codex!,
    {
      job: 'review-lens',
      prompt: 'review',
      probe: true,
      probeContextLimit: 'served',
    },
    job('review-lens'),
  )
  expect(launch).toEqual({
    refusal: '--probe-context-limit requires the goose harness; selected harness is codex',
    environment: {},
    contextLimit: undefined,
    readerSuites: false,
  })
})

test('an accepted probe launch carries the served window and reader suites', () => {
  const goose = { ...AGENTS.codex!, harness: 'goose', servedContextTokens: 200_000 }
  const opts = {
    job: 'review-lens',
    prompt: 'review',
    probe: true,
    probeContextLimit: 'served' as const,
    probeReaderSuites: true,
  }
  expect(prepareRunProbeLaunch(goose, opts, job('review-lens'))).toEqual({
    refusal: null,
    environment: { GOOSE_CONTEXT_LIMIT: '200000' },
    contextLimit: 'served',
    readerSuites: true,
  })
  expect(probeReaderFindings(opts, job('review-lens'))).toBe(false)
})

test('launch logging names each probe override in effect', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    reportProbeOverrides('run-42', { GOOSE_CONTEXT_LIMIT: '180000' }, true)
    expect(error).toHaveBeenNthCalledWith(
      1,
      'orch: run run-42 probe override GOOSE_CONTEXT_LIMIT=180000 (replaces the ceilinged limit; ceiling 128000)',
    )
    expect(error).toHaveBeenNthCalledWith(
      2,
      'orch: run run-42 probe override reader-suites wording',
    )
  } finally {
    mock.restore()
  }
})
