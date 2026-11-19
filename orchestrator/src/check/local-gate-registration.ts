import { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type LocalGateRegistrationProbe =
  | { kind: 'registered' }
  | { kind: 'unregistered' }
  | { kind: 'absent-store' }
  | { kind: 'absent-register' }
  | { kind: 'unreadable-store'; detail: string }

export type LocalGateRegistrationDecision =
  | { kind: 'run' }
  | { kind: 'skip'; message: string }
  | { kind: 'fail'; message: string }

/** Pure policy for the machine-state checks that require this checkout's register row. */
export function localGateRegistrationDecision(
  checkout: string,
  probe: LocalGateRegistrationProbe,
): LocalGateRegistrationDecision {
  if (probe.kind === 'registered') return { kind: 'run' }
  if (probe.kind === 'unreadable-store') {
    return {
      kind: 'fail',
      message: `cannot read the project register for checkout ${checkout}: ${probe.detail}`,
    }
  }
  const reason =
    probe.kind === 'absent-store'
      ? 'the orchestrator store is absent'
      : probe.kind === 'absent-register'
        ? 'the orchestrator store has no project register'
        : 'the project register has no project containing this checkout'
  return {
    kind: 'skip',
    message: `checkout ${checkout} is not registered because ${reason}; remedy: ${PLATFORM_SLUG} project add ${JSON.stringify(checkout)}`,
  }
}

/** Read only the registration facts needed by the local machine-state check policy. */
export function probeLocalGateRegistration(
  checkout: string,
  storePath: string | null,
): LocalGateRegistrationProbe {
  if (!storePath) return { kind: 'absent-store' }
  let database: Database
  try {
    database = new Database(storePath, { readonly: true })
  } catch (cause) {
    return {
      kind: 'unreadable-store',
      detail: String((cause as Error).message ?? cause),
    }
  }
  try {
    const projectTable = database
      .query("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='project'")
      .get()
    if (!projectTable) return { kind: 'absent-register' }
    const rows = database.query('SELECT path, retired_at FROM project').all() as {
      path: string
      retired_at: string | null
    }[]
    const registered = rows.some(
      (row) =>
        row.retired_at === null && (checkout === row.path || checkout.startsWith(`${row.path}/`)),
    )
    return registered ? { kind: 'registered' } : { kind: 'unregistered' }
  } catch (cause) {
    return {
      kind: 'unreadable-store',
      detail: String((cause as Error).message ?? cause),
    }
  } finally {
    database.close()
  }
}
