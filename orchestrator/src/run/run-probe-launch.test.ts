import { expect, mock, spyOn, test } from 'bun:test'
import { AGENTS } from '../agent/agent-registry.ts'
import { job } from '../jobs/jobs.ts'
import { prepareRunProbeLaunch, reportProbeOverrides } from './run-probe-launch.ts'

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
  })
})

test('launch logging names each probe override in effect', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    reportProbeOverrides('run-42', { GOOSE_CONTEXT_LIMIT: '180000' }, true)
    expect(error).toHaveBeenNthCalledWith(
      1,
      'orch: run run-42 probe override GOOSE_CONTEXT_LIMIT=180000 (ceiling 128000 bypassed)',
    )
    expect(error).toHaveBeenNthCalledWith(
      2,
      'orch: run run-42 probe override reader-suites wording',
    )
  } finally {
    mock.restore()
  }
})
