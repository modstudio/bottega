// concern: hosted-record-service-connection
/** Supplies transaction bounds for long-lived hosted service connections. */

export const RECORD_SERVICE_STATEMENT_TIMEOUT = '1min'
export const RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT = '30s'

// No service code may hold a transaction open across a network await or wait. The change feed's
// cutoff is the oldest open transaction on the record's whole Postgres cluster, so any connection
// to it, the auth clients' included, holds every machine's feed back while a transaction idles;
// this idle bound terminates such a connection instead.
export function recordServiceUrl(url: string): string {
  const configured = new URL(url)
  const existing = configured.searchParams.get('options')?.trim()
  const bounds = `-c statement_timeout=${RECORD_SERVICE_STATEMENT_TIMEOUT} -c idle_in_transaction_session_timeout=${RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT}`
  configured.searchParams.set('options', existing ? `${existing} ${bounds}` : bounds)
  return configured.toString()
}
