import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { type LaunchAgentSkipFacts, launchAgentSkipReason } from './launch-agent-skip.ts'

const configEnvPath = `/home/user/.config/${PLATFORM_SLUG}/${PLATFORM_SLUG}.env`
const configured: LaunchAgentSkipFacts = {
  modelHostAlias: 'model-host',
  recordTunnelApp: 'record-app',
  flyctlOnPath: true,
  envFilePaths: ['/home/user/.claude/.env', configEnvPath],
  anyEnvFileExists: true,
}

describe('launch agent installer skip decision', () => {
  test('uses the installer reasons for every conditional agent', () => {
    expect(
      launchAgentSkipReason('com.user.local-model-tunnel', {
        ...configured,
        modelHostAlias: '',
      }),
    ).toBe('model_host.ssh_alias is unset')
    expect(
      launchAgentSkipReason('com.user.record-tunnel', { ...configured, recordTunnelApp: '' }),
    ).toBe('record.tunnel_app is unset')
    expect(
      launchAgentSkipReason('com.user.record-tunnel', { ...configured, flyctlOnPath: false }),
    ).toBe('flyctl is not on PATH')
    expect(
      launchAgentSkipReason('com.user.orch-record-sync', {
        ...configured,
        anyEnvFileExists: false,
      }),
    ).toBe(`env files are absent: /home/user/.claude/.env ${configEnvPath}`)
  })

  test('does not skip configured or unconditional agents', () => {
    expect(launchAgentSkipReason('com.user.record-tunnel', configured)).toBeNull()
    expect(launchAgentSkipReason('com.user.orch-load-sample', configured)).toBeNull()
  })
})
