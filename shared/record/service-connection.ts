// concern: hosted-record-service-connection
/** Supplies transaction bounds for long-lived hosted service connections. */

export const RECORD_SERVICE_STATEMENT_TIMEOUT = '60s'
export const RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT = '30s'

// No service code may hold a transaction open across a network await or wait. The later
// long-poll feed relies on that: an open transaction holds every machine's feed cutoff back,
// and this idle bound would terminate the connection while it waited.
export function recordServiceUrl(url: string): string {
  const configured = new URL(url)
  const existing = configured.searchParams.get('options')?.trim()
  const bounds = `-c statement_timeout=${RECORD_SERVICE_STATEMENT_TIMEOUT} -c idle_in_transaction_session_timeout=${RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT}`
  configured.searchParams.set('options', existing ? `${existing} ${bounds}` : bounds)
  return configured.toString()
}
