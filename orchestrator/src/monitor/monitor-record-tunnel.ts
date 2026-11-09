// concern: monitor-record-tunnel
/** Classifies the observed record tunnel, whether configured or unconfigured. */

import { createConnection } from 'node:net'
import { ConfigClientError } from '../../../shared/config-client.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { RECORD_MIGRATE_OPERATOR_CREDENTIAL } from '../../../shared/operator-credentials.ts'
import { operatorCredentialPresent } from '../config/operator-credential.ts'
import {
  RECORD_TUNNEL_DOWN_REMEDY,
  type RecordTunnelConfigurationFacts,
  recordTunnelIsUnconfigured,
  recordTunnelUnconfiguredRemedy,
} from '../record/record-tunnel-error.ts'
import type { MonitorCondition } from './monitor-types.ts'

const RECORD_TUNNEL_PROBE_TIMEOUT_MS = 500

/** Classify the record tunnel from already-observed configuration and endpoint facts. */
export function recordTunnelCondition(
  facts: RecordTunnelConfigurationFacts & {
    port: number
    reachable: boolean
  },
): MonitorCondition | null {
  if (recordTunnelIsUnconfigured(facts))
    return {
      kind: 'record-tunnel-unconfigured',
      subject: 'record.tunnel_app',
      since: null,
      ageMs: null,
      detail: 'record.tunnel_app is empty, so com.user.record-tunnel cannot be installed',
      action: recordTunnelUnconfiguredRemedy(),
    }
  if (!facts.tunnelApp || facts.reachable) return null
  return {
    kind: 'record-tunnel-down',
    subject: `127.0.0.1:${facts.port}`,
    since: null,
    ageMs: null,
    detail: `record tunnel com.user.record-tunnel is not accepting TCP connections on 127.0.0.1:${facts.port}`,
    action: RECORD_TUNNEL_DOWN_REMEDY,
  }
}

function tcpEndpointReachable(port: number): Promise<boolean> {
  return new Promise((resolveReachable) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const settle = (reachable: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveReachable(reachable)
    }
    socket.setTimeout(RECORD_TUNNEL_PROBE_TIMEOUT_MS)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
    socket.once('close', () => settle(false))
  })
}

export async function observeRecordTunnel(
  credentialPresent: () => Promise<boolean> = () =>
    operatorCredentialPresent(RECORD_MIGRATE_OPERATOR_CREDENTIAL),
): Promise<{
  conditions: MonitorCondition[]
  errors: string[]
}> {
  try {
    const app = readMachineValue('record.tunnel_app')
    if (!app) {
      const condition = recordTunnelCondition({
        tunnelApp: app,
        requiresTunnel: await credentialPresent(),
        port: 0,
        reachable: false,
      })
      return { conditions: condition ? [condition] : [], errors: [] }
    }
    const port = readMachineValue('record.tunnel_local_port')
    const condition = recordTunnelCondition({
      tunnelApp: app,
      requiresTunnel: false,
      port,
      reachable: await tcpEndpointReachable(port),
    })
    return { conditions: condition ? [condition] : [], errors: [] }
  } catch (cause) {
    if (cause instanceof ConfigClientError && cause.reason === 'not-configured')
      return { conditions: [], errors: [] }
    return {
      conditions: [],
      errors: [`record tunnel observation: ${String((cause as Error).message ?? cause)}`],
    }
  }
}
