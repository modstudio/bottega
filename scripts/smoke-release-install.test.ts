import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../shared/brand.ts'
import {
  harnessInstallerInvocationCounts,
  releaseDownloadsReachedCurl,
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
  expect(env.HOME).toBe('/proof/home')
  expect(env.BOTTEGA_STATE_HOME).toBe('/proof/state')
  expect(env.BOTTEGA_INSTALL_DIR).toBe('/proof/bin')
  expect(env.BOTTEGA_DOWNLOAD_BASE_URL).toBe('file:///proof/mirror')
  expect(env.PATH).toBe(
    '/proof/stub:/proof/home/.grok/bin:/proof/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  )
})

test('release proof log decisions distinguish installers from forwarded downloads', () => {
  const archive = `${PLATFORM_NAME}-0.5.8-darwin-arm64.tar.gz`
  const curlLog = [
    '-fsSL file:///proof/mirror/download/v0.5.8/SHA256SUMS -o /tmp/proof/SHA256SUMS',
    `-fsSL file:///proof/mirror/download/v0.5.8/${archive} -o /tmp/proof/archive`,
    '-fsSL https://x.ai/cli/install.sh',
  ].join('\n')
  expect(harnessInstallerInvocationCounts('install --cask codex\n', curlLog)).toEqual({
    brewCodex: 1,
    curlGrok: 1,
  })
  expect(
    releaseDownloadsReachedCurl(curlLog, 'file:///proof/mirror/download/v0.5.8', archive),
  ).toBe(true)
  expect(
    releaseDownloadsReachedCurl(
      '-fsSL https://x.ai/cli/install.sh\n',
      'file:///proof/mirror/download/v0.5.8',
      archive,
    ),
  ).toBe(false)
})
