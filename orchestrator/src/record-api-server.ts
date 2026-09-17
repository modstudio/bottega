// concern: record-api-server
/** Composes and serves the record API. Must not own record queries or authentication policy. */
import { probeRecord, recordMigrationCount } from './postgres/postgres-migrate.ts'
import { recordApi } from './record-api.ts'
import { recordAllowedOrigins, recordAuth, recordIdentity } from './record-auth.ts'
import {
  consumeRecordDoc,
  countRecordDocs,
  deleteRecordDoc,
  getRecordDoc,
  importRecordDoc,
  listRecordDocRevisions,
  listRecordDocs,
  renameRecordDocSubject,
  restoreRecordDoc,
  upsertRecordDoc,
} from './record-docs.ts'
import { listRecordProjects } from './record-projects.ts'
import { getRecordReview, listRecordReviews } from './record-reviews.ts'
import { getRecordRun, listRecordRuns } from './record-runs.ts'
import { listRecordSnapshots, upsertRecordSnapshot } from './record-snapshots.ts'
import {
  countRecordScores,
  listRecordScores,
  upsertRecordScore,
  voidRecordRun,
} from './record-verdicts.ts'

type ServerEnvironment = Record<string, string | undefined>

function required(environment: ServerEnvironment, name: string): string {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required to serve the record API`)
  return value
}

export function recordApiServerConfig(environment: ServerEnvironment = process.env) {
  const port = Number(environment.PORT ?? '3000')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer from 0 through 65535')
  }
  return {
    port,
    recordUrl: required(environment, 'ORCH_RECORD_URL'),
    authSecret: required(environment, 'BETTER_AUTH_SECRET'),
    authUrl: required(environment, 'BETTER_AUTH_URL'),
    allowedOrigins: recordAllowedOrigins(environment),
  }
}

export function startRecordApiServer(environment: ServerEnvironment = process.env) {
  const config = recordApiServerConfig(environment)
  const auth = recordAuth(config.recordUrl, environment)
  const migrations = recordMigrationCount()
  const app = recordApi({
    recordUrl: config.recordUrl,
    allowedOrigins: config.allowedOrigins,
    auth,
    readSession: async (headers) => {
      const current = await auth.api.getSession({ headers })
      if (!current) return null
      return recordIdentity(
        config.recordUrl,
        current.user,
        current.session.activeOrganizationId ?? null,
      )
    },
    readHealth: async () => {
      try {
        await probeRecord(config.recordUrl)
        return { ok: true, migrations }
      } catch {
        return { ok: false, migrations }
      }
    },
    readRuns: listRecordRuns,
    readRun: getRecordRun,
    readReviews: listRecordReviews,
    readReview: getRecordReview,
    readProjects: listRecordProjects,
    listDocs: listRecordDocs,
    readDoc: getRecordDoc,
    listDocRevisions: listRecordDocRevisions,
    upsertDoc: upsertRecordDoc,
    importDoc: importRecordDoc,
    deleteDoc: deleteRecordDoc,
    consumeDoc: consumeRecordDoc,
    restoreDoc: restoreRecordDoc,
    renameDocSubject: renameRecordDocSubject,
    countDocs: countRecordDocs,
    upsertScore: async (input) =>
      upsertRecordScore({
        ...input,
        delivery: input.delivery as 'none' | 'partial' | 'full',
        quality: input.quality as 'wrong' | 'mixed' | 'right' | null,
        fidelity: input.fidelity as 'drifted' | 'partial' | 'faithful' | null,
      }),
    voidRun: voidRecordRun,
    listScores: listRecordScores,
    countScores: countRecordScores,
    upsertSnapshot: upsertRecordSnapshot,
    listSnapshots: listRecordSnapshots,
  })
  return Bun.serve({
    hostname: '0.0.0.0',
    port: config.port,
    fetch: async (request) => {
      const started = performance.now()
      const response = await app.fetch(request)
      console.log(
        `${request.method} ${new URL(request.url).pathname} ${response.status} ${Math.round(performance.now() - started)}ms`,
      )
      return response
    },
  })
}

if (import.meta.main) startRecordApiServer()
