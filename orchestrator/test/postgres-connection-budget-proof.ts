import { expect, test } from 'bun:test'

const MAX_REMAINING_CLIENT_CONNECTIONS = 20
const CLIENT_CONNECTION_PROBE =
  "SELECT usename, state, count(*) FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY 1,2 ORDER BY 1,2;"

export function registerConnectionBudgetProof(succeeds: (source: string) => string): void {
  test('the RLS proof suite leaves the Postgres client connection budget bounded', () => {
    const remaining = Number(
      succeeds("SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend';"),
    )
    expect(
      remaining,
      `record auth connection leak: ${remaining} client backends remain; inspect them with: ${CLIENT_CONNECTION_PROBE}`,
    ).toBeLessThanOrEqual(MAX_REMAINING_CLIENT_CONNECTIONS)
  })
}
