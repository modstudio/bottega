import { expect, test } from 'bun:test'
import {
  attributedFailureLines,
  launchctlStub,
  releaseInstallEnvironment,
} from './smoke-release-install.ts'

test('release install environment drops inherited product and harness overrides', () => {
  const env = releaseInstallEnvironment(
    {
      BOTTEGA_ORCHESTRATOR_DB: '/live/orchestrator.db',
      BOTTEGA_HOME: '/live/home',
      CLAUDE_CODE_SESSION_ID: 'live-session',
      UNRELATED: 'preserved',
    },
    {
      home: '/proof/home',
      state: '/proof/state',
      bin: '/proof/bin',
      stub: '/proof/stub',
      mirror: '/proof/mirror',
    },
  )

  expect(env).not.toHaveProperty('BOTTEGA_ORCHESTRATOR_DB')
  expect(env).not.toHaveProperty('BOTTEGA_HOME')
  expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
  expect(env.UNRELATED).toBe('preserved')
  expect(launchctlStub('/proof/launchctl-state', '/proof/launchctl.log')).toContain(
    "state='/proof/launchctl-state'",
  )
})

test('failure attribution keeps drift and drops passing output', () => {
  expect(
    attributedFailureLines('machine setup passed\ncom.user.orch-sweep DEFINITION DRIFTED\n'),
  ).toEqual(['com.user.orch-sweep DEFINITION DRIFTED'])
})
