// concern: weaker-network-isolation
/**
 * Whether an agent row's endpoint requires SRT's weaker network isolation.
 * Must not know profiles, launches, or the runtime.
 */

import { BlockList, isIP } from 'node:net'

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

type AgentEndpointRow = {
  base_url?: string | null
}

type WeakerNetworkIsolation = {
  enabled: boolean
  reason: string | null
}

/** Hostname of an agent endpoint URL. */
export function endpointHost(baseUrl: string | null | undefined): string[] {
  if (!baseUrl) return []
  try {
    return [new URL(baseUrl).hostname]
  } catch {
    return []
  }
}

function isHttpsEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function unwrapHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isLoopbackHost(host: string): boolean {
  const address = unwrapHost(host)
  if (address.toLowerCase() === 'localhost') return true
  const version = isIP(address)
  if (version === 4) return LOOPBACK.check(address, 'ipv4')
  if (version === 6) return LOOPBACK.check(address, 'ipv6')
  return false
}

/** Enable weaker isolation only for a remote HTTPS agent endpoint. */
export function decideWeakerNetworkIsolation(row: AgentEndpointRow): WeakerNetworkIsolation {
  const host = endpointHost(row.base_url)[0]
  if (!host || isLoopbackHost(host) || !row.base_url || !isHttpsEndpoint(row.base_url)) {
    return { enabled: false, reason: null }
  }
  return {
    enabled: true,
    reason:
      `weaker network isolation enabled: remote HTTPS endpoint ${host} ` +
      'requires macOS trustd for TLS verification',
  }
}
