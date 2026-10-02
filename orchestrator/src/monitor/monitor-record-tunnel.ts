// concern: monitor-record-tunnel
/** Owns the record tunnel TCP observation adapter. */

import { createConnection } from 'node:net'
import { readMachineValue } from '../../../shared/machine-config.ts'
import type { MonitorCondition } from './monitor-types.ts'

const RECORD_TUNNEL_PROBE_TIMEOUT_MS = 500

/** Classify the configured record tunnel from already-observed endpoint facts. */
export function recordTunnelCondition(facts: {
  app: string
  port: number
  reachable: boolean
}): MonitorCondition | null {
  if (!facts.app || facts.reachable) return null
  return {
    kind: 'record-tunnel-down',
    subject: `127.0.0.1:${facts.port}`,
    since: null,
    ageMs: null,
    detail: `record tunnel com.user.record-tunnel is not accepting TCP connections on 127.0.0.1:${facts.port}`,
    action: 'run launchctl kickstart -k gui/$(id -u)/com.user.record-tunnel',
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

export async function observeRecordTunnel(): Promise<{
  conditions: MonitorCondition[]
  errors: string[]
}> {
  try {
    const app = readMachineValue('record.tunnel_app')
    if (!app) return { conditions: [], errors: [] }
    const port = readMachineValue('record.tunnel_local_port')
    const condition = recordTunnelCondition({
      app,
      port,
      reachable: await tcpEndpointReachable(port),
    })
    return { conditions: condition ? [condition] : [], errors: [] }
  } catch (cause) {
    return {
      conditions: [],
      errors: [`record tunnel observation: ${String((cause as Error).message ?? cause)}`],
    }
  }
}
