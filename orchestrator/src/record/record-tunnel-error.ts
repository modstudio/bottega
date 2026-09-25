// concern: record-tunnel-error
/** Owns the operator-facing remedy for connection failures through the configured record tunnel. */

const CONNECTION_FAILURE =
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|connection (?:refused|closed|reset)|connect(?:ion)? timed out|connection timeout/i

export const RECORD_TUNNEL_REMEDY = 'launchctl kickstart -k gui/$(id -u)/com.user.record-tunnel'

/** Add the supervised-tunnel remedy only to connection-class failures on configured machines. */
export function recordTunnelFailure(message: string, tunnelApp: string): string {
  if (!tunnelApp || !CONNECTION_FAILURE.test(message)) return message
  return `${message}\nrecord tunnel com.user.record-tunnel is unavailable; run ${RECORD_TUNNEL_REMEDY}`
}
