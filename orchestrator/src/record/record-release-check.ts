// concern: record-release-check
/** Refuses a hosted release when its image expects migrations the record has not applied. */

import { appliedRecordMigrationCount, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { decideRecordRelease } from './record-release-decision.ts'

type HostedApp = 'api' | 'hub'

function hostedApp(value: string | undefined): HostedApp {
  if (value === 'api' || value === 'hub') return value
  throw new Error('release check requires exactly one app: api or hub')
}

function appRecordUrl(app: HostedApp): { name: string; value: string } {
  const name = app === 'api' ? 'ORCH_RECORD_URL' : 'HUB_RECORD_DATABASE_URL'
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the ${app} release check`)
  return { name, value }
}

export async function recordReleaseCheck(app: HostedApp): Promise<void> {
  const recordUrl = appRecordUrl(app)
  let applied: number
  try {
    applied = await appliedRecordMigrationCount(recordUrl.value)
  } catch {
    throw new Error(
      `release check could not read drizzle.__drizzle_migrations with ${recordUrl.name}; run \`scripts/deploy/hosted ${app}\` or \`orch record migrate\`, then retry`,
    )
  }
  const decision = decideRecordRelease(applied, recordMigrationCount())
  if (decision.status === 'refuse') {
    throw new Error(
      `release refused: applied migrations ${decision.applied}; shipped migrations ${decision.shipped}; run \`scripts/deploy/hosted ${app}\` or \`orch record migrate\`, then retry`,
    )
  }
  if (decision.status === 'warn') {
    console.warn(
      `WARNING: applied migrations ${decision.applied} exceed shipped migrations ${decision.shipped}; allowing rollback release`,
    )
    return
  }
  console.log(`record migrations ready: applied ${decision.applied}; shipped ${decision.shipped}`)
}

if (import.meta.main) {
  try {
    await recordReleaseCheck(hostedApp(process.argv[2]))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
