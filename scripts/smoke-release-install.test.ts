import { expect, test } from 'bun:test'
import { releaseInstallEnvironment } from './smoke-release-install.ts'

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
  expect(env.HOME).toBe('/proof/home')
  expect(env.BOTTEGA_STATE_HOME).toBe('/proof/state')
  expect(env.BOTTEGA_INSTALL_DIR).toBe('/proof/bin')
  expect(env.BOTTEGA_DOWNLOAD_BASE_URL).toBe('file:///proof/mirror')
  expect(env.PATH).toBe('/proof/stub:/proof/bin:/usr/bin:/bin:/usr/sbin:/sbin')
})
