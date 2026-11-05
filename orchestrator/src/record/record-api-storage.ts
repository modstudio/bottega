// concern: record storage API
/** Owns platform-owner authorization for the catalog-only storage route. */

import type { Context, Hono } from 'hono'
import type { TableStorageMeasurement } from '../../../shared/storage-lifecycle.ts'
import type { RecordIdentity } from './record-auth.ts'

const PLATFORM_OWNER_USER_IDS_SETTING = 'BOTTEGA_PLATFORM_OWNER_USER_IDS'
type Environment = { Variables: { identity: RecordIdentity } }

export function platformOwnerUserIds(environment: Record<string, string | undefined>): string[] {
  return (environment[PLATFORM_OWNER_USER_IDS_SETTING] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function registerRecordStorageRoute(
  app: Hono<Environment>,
  dependencies: {
    platformOwnerUserIds(): readonly string[]
    readStorage(): Promise<TableStorageMeasurement[]>
  },
): void {
  app.get('/v1/storage', async (context: Context<Environment>) => {
    const allowed = dependencies.platformOwnerUserIds()
    if (!allowed.length)
      return context.json(
        {
          error: `${PLATFORM_OWNER_USER_IDS_SETTING} is unset or empty; hosted storage is restricted to configured platform owners`,
        },
        403,
      )
    if (!allowed.includes(context.get('identity').user.id))
      return context.json(
        { error: 'hosted storage is restricted to configured platform owners' },
        403,
      )
    return context.json({ tables: await dependencies.readStorage() })
  })
}
