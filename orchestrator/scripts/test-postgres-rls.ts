#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import {
  RECORD_ACTOR_ROLE,
  RECORD_AUTH_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_PUBLIC_ROLE,
  RECORD_READER_ROLE,
} from '../../shared/record/schema.ts'
import { resolveHubDatabase, resolveOrchestratorDatabase } from '../../shared/state-directory.ts'

const falsify = process.argv.includes('--falsify')
const withoutLiveImport = process.argv.includes('--without-live-import')
const falsifyMode = falsify
  ? 'revoke-project-select'
  : (process.env.BOTTEGA_TEST_POSTGRES_FALSIFY ?? '')
const provisionedContainer = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
const container = provisionedContainer ?? `dev-445-postgres-${randomUUID().slice(0, 8)}`
const sourceCopies = mkdtempSync(join(tmpdir(), 'dev-429-sources-'))
const sourceOrchDb = join(sourceCopies, FROZEN_STATE_NAMES.orchestratorDatabase)
const sourceHubDb = join(sourceCopies, FROZEN_STATE_NAMES.hubDatabase)
const LIVE_COPY_PHASE_TIMEOUT_MS = 900_000
// Migrate never calls the API; this placeholder only declares a hosted-record install.
const RECORD_API_URL = 'http://127.0.0.1:9'
if (withoutLiveImport)
  console.log('copied-live-SQLite import proof omitted: no operator store on the runner')
class EarlyExit {
  readonly code: number
  constructor(code: number) {
    this.code = code
  }
}
function copyDatabase(source: string, target: string): void {
  copyFileSync(source, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${target}${suffix}`)
  }
}

async function run(argv: string[], env?: Record<string, string>): Promise<number> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('BOTTEGA_RECORD_')),
  )
  const child = Bun.spawn(argv, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...inheritedEnv, ...env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exited
}

function postgres(source: string, database = 'postgres'): void {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdin: new Blob([source]), stdout: 'inherit', stderr: 'inherit' },
  )
  if (result.exitCode !== 0) throw new Error(`Postgres fixture command exited ${result.exitCode}`)
}

let launched = false
let started = false
let released = false
function release(): void {
  if (released) return
  released = true
  if (started) {
    try {
      postgres(`
        DROP DATABASE IF EXISTS recipient_migration WITH (FORCE);
        DROP DATABASE IF EXISTS hosted_task_id_migration WITH (FORCE);
        DROP DATABASE IF EXISTS doc_revision_migration WITH (FORCE);
        DROP DATABASE IF EXISTS doc_author_migration WITH (FORCE);
        DROP DATABASE IF EXISTS public_role_migration WITH (FORCE);
        DROP DATABASE IF EXISTS board_shared_space_migration WITH (FORCE);
        DROP DATABASE IF EXISTS board_shared_space_invalid_migration WITH (FORCE);
        DROP DATABASE IF EXISTS hub_project_identity_migration WITH (FORCE);
        DROP DATABASE IF EXISTS run_task_reference_migration WITH (FORCE);
        DROP DATABASE IF EXISTS workflow_generation_migration WITH (FORCE);
        DROP DATABASE IF EXISTS workflow_catalogue WITH (FORCE);
        DROP DATABASE IF EXISTS lens_catalogue WITH (FORCE);
        DROP DATABASE IF EXISTS port_catalogue WITH (FORCE);
        DROP DATABASE IF EXISTS hosted_project_cleanup_migration WITH (FORCE);
        DROP DATABASE IF EXISTS hosted_project_cleanup_collision WITH (FORCE);
        REASSIGN OWNED BY ${RECORD_OWNER_ROLE} TO postgres;
        DROP OWNED BY ${RECORD_OWNER_ROLE};
        DROP OWNED BY ${RECORD_ACTOR_ROLE};
        DROP OWNED BY ${RECORD_AUTH_ROLE};
        DROP OWNED BY ${RECORD_PUBLIC_ROLE};
        DROP OWNED BY ${RECORD_READER_ROLE};
        DROP OWNED BY public_probe;
        DROP ROLE IF EXISTS public_probe;
        DROP ROLE IF EXISTS ${RECORD_READER_ROLE};
        DROP ROLE IF EXISTS ${RECORD_ACTOR_ROLE};
        DROP ROLE IF EXISTS ${RECORD_AUTH_ROLE};
        DROP ROLE IF EXISTS ${RECORD_PUBLIC_ROLE};
        DROP ROLE IF EXISTS ${RECORD_OWNER_ROLE};
      `)
    } catch (error) {
      console.error(error)
      process.exitCode ||= 1
    }
  }
  // An interrupted start can still have created the container, so removal does not wait on readiness.
  if (launched)
    Bun.spawnSync(['docker', 'rm', '-f', '-v', container], { stdout: 'ignore', stderr: 'ignore' })
  rmSync(sourceCopies, { recursive: true, force: true })
}

const signalHandlers = {
  SIGINT: () => {
    release()
    process.exit(130)
  },
  SIGTERM: () => {
    release()
    process.exit(143)
  },
}
process.on('SIGINT', signalHandlers.SIGINT)
process.on('SIGTERM', signalHandlers.SIGTERM)

try {
  if (!withoutLiveImport) {
    copyDatabase(resolveOrchestratorDatabase(process.env), sourceOrchDb)
    copyDatabase(resolveHubDatabase(process.env), sourceHubDb)
  }
  if (!provisionedContainer) {
    launched = true
    // Synchronous so no signal handler runs between the container starting and `started` being set.
    const start = Bun.spawnSync(
      [
        'docker',
        'run',
        '--rm',
        '--name',
        container,
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-p',
        '127.0.0.1::5432',
        '-d',
        'postgres:18-alpine',
        '-c',
        'max_connections=200',
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    ).exitCode
    if (start !== 0) throw new EarlyExit(start)
  }
  started = true

  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = Bun.spawnSync(
      ['docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    if (probe.exitCode === 0) {
      ready = true
      break
    }
    await Bun.sleep(250)
  }
  if (!ready) throw new Error('disposable Postgres did not become ready')

  const portResult = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (portResult.exitCode !== 0) throw new Error(portResult.stderr.toString())
  const port = portResult.stdout.toString().trim().split(':').at(-1)
  if (!port) throw new Error('disposable Postgres published no host port')

  postgres(`
    CREATE ROLE ${RECORD_OWNER_ROLE} LOGIN PASSWORD 'owner-password' NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_ACTOR_ROLE} LOGIN PASSWORD 'actor-password' NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_AUTH_ROLE} LOGIN PASSWORD 'auth-password' NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_PUBLIC_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_READER_ROLE} LOGIN PASSWORD 'reader-password' NOSUPERUSER NOBYPASSRLS;
    GRANT ${RECORD_PUBLIC_ROLE} TO ${RECORD_ACTOR_ROLE} WITH INHERIT FALSE, SET TRUE;
    CREATE ROLE public_probe LOGIN PASSWORD 'public-password' NOSUPERUSER NOBYPASSRLS;
    GRANT CREATE ON DATABASE postgres TO ${RECORD_OWNER_ROLE};
    ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};
    CREATE DATABASE recipient_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE hosted_task_id_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE hub_project_identity_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE run_task_reference_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE doc_revision_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE doc_author_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE public_role_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE board_shared_space_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE board_shared_space_invalid_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE workflow_generation_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE workflow_catalogue OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE lens_catalogue OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE port_catalogue OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE hosted_project_cleanup_migration OWNER ${RECORD_OWNER_ROLE};
    CREATE DATABASE hosted_project_cleanup_collision OWNER ${RECORD_OWNER_ROLE};
  `)
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'recipient_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'hosted_task_id_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'hub_project_identity_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'run_task_reference_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'doc_revision_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'doc_author_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'public_role_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'board_shared_space_migration')
  postgres(
    `ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`,
    'board_shared_space_invalid_migration',
  )
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'workflow_generation_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'workflow_catalogue')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'lens_catalogue')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'port_catalogue')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'hosted_project_cleanup_migration')
  postgres(`ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};`, 'hosted_project_cleanup_collision')

  const ownerUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/postgres`
  const actorUrl = `postgres://${RECORD_ACTOR_ROLE}:actor-password@127.0.0.1:${port}/postgres`
  const authUrl = `postgres://${RECORD_AUTH_ROLE}:auth-password@127.0.0.1:${port}/postgres`
  const recipientMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/recipient_migration`
  const hostedTaskIdMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/hosted_task_id_migration`
  const hubProjectIdentityMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/hub_project_identity_migration`
  const runTaskReferenceMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/run_task_reference_migration`
  const docRevisionMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/doc_revision_migration`
  const docRevisionMigrationSuperuserUrl = `postgres://postgres:postgres@127.0.0.1:${port}/doc_revision_migration`
  const docAuthorMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/doc_author_migration`
  const docAuthorMigrationSuperuserUrl = `postgres://postgres:postgres@127.0.0.1:${port}/doc_author_migration`
  const publicRoleMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/public_role_migration`
  const publicRoleMigrationSuperuserUrl = `postgres://postgres:postgres@127.0.0.1:${port}/public_role_migration`
  const boardSharedSpaceMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/board_shared_space_migration`
  const boardSharedSpaceInvalidMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/board_shared_space_invalid_migration`
  const workflowGenerationMigrationUrl = `postgres://postgres:postgres@127.0.0.1:${port}/workflow_generation_migration`
  const workflowCatalogueUrl = `postgres://postgres:postgres@127.0.0.1:${port}/workflow_catalogue`
  const lensCatalogueUrl = `postgres://postgres:postgres@127.0.0.1:${port}/lens_catalogue`
  const portCatalogueUrl = `postgres://postgres:postgres@127.0.0.1:${port}/port_catalogue`
  const hostedProjectCleanupMigrationUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/hosted_project_cleanup_migration`
  const hostedProjectCleanupCollisionUrl = `postgres://${RECORD_OWNER_ROLE}:owner-password@127.0.0.1:${port}/hosted_project_cleanup_collision`

  const hostedProjectCleanupMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/postgres/postgres-migrate-hosted-project-cleanup.test.ts',
    ],
    {
      BOTTEGA_TEST_HOSTED_PROJECT_CLEANUP_URL: hostedProjectCleanupMigrationUrl,
      BOTTEGA_TEST_HOSTED_PROJECT_CLEANUP_COLLISION_URL: hostedProjectCleanupCollisionUrl,
    },
  )
  if (hostedProjectCleanupMigration !== 0) throw new EarlyExit(hostedProjectCleanupMigration)

  const boardSharedSpaceMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/postgres/postgres-migrate-board-shared-space.test.ts',
    ],
    {
      BOTTEGA_TEST_BOARD_SHARED_SPACE_MIGRATION_URL: boardSharedSpaceMigrationUrl,
      BOTTEGA_TEST_BOARD_SHARED_SPACE_INVALID_MIGRATION_URL: boardSharedSpaceInvalidMigrationUrl,
    },
  )
  if (boardSharedSpaceMigration !== 0) throw new EarlyExit(boardSharedSpaceMigration)

  const publicRoleMigration = await run(
    ['bun', 'test', '--timeout', '30000', 'src/postgres/postgres-migrate-public-role.test.ts'],
    {
      BOTTEGA_TEST_PUBLIC_ROLE_MIGRATION_URL: publicRoleMigrationUrl,
      BOTTEGA_TEST_PUBLIC_ROLE_MIGRATION_SUPERUSER_URL: publicRoleMigrationSuperuserUrl,
    },
  )
  if (publicRoleMigration !== 0) throw new EarlyExit(publicRoleMigration)

  const recipientMigration = await run(
    ['bun', 'test', '--timeout', '30000', 'src/postgres/postgres-migrate-recipients.test.ts'],
    { BOTTEGA_TEST_RECIPIENT_MIGRATION_URL: recipientMigrationUrl },
  )
  if (recipientMigration !== 0) throw new EarlyExit(recipientMigration)

  const hostedTaskIdMigration = await run(
    ['bun', 'test', '--timeout', '30000', 'src/postgres/postgres-migrate-hosted-task-ids.test.ts'],
    { BOTTEGA_TEST_HOSTED_TASK_ID_MIGRATION_URL: hostedTaskIdMigrationUrl },
  )
  if (hostedTaskIdMigration !== 0) throw new EarlyExit(hostedTaskIdMigration)

  const workflowGenerationMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/postgres/postgres-migrate-workflow-generation.test.ts',
    ],
    { BOTTEGA_TEST_WORKFLOW_GENERATION_MIGRATION_URL: workflowGenerationMigrationUrl },
  )
  if (workflowGenerationMigration !== 0) throw new EarlyExit(workflowGenerationMigration)

  const hubProjectIdentityMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/postgres/postgres-migrate-hub-project-identity.test.ts',
    ],
    { BOTTEGA_TEST_HUB_PROJECT_IDENTITY_MIGRATION_URL: hubProjectIdentityMigrationUrl },
  )
  if (hubProjectIdentityMigration !== 0) throw new EarlyExit(hubProjectIdentityMigration)

  const runTaskReferenceMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/record/record-sync-service-run-task-backfill.test.ts',
    ],
    { BOTTEGA_TEST_RUN_TASK_REFERENCE_MIGRATION_URL: runTaskReferenceMigrationUrl },
  )
  if (runTaskReferenceMigration !== 0) throw new EarlyExit(runTaskReferenceMigration)

  const docRevisionMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/postgres/postgres-migrate-doc-latest-revision.test.ts',
    ],
    {
      BOTTEGA_TEST_DOC_REVISION_MIGRATION_URL: docRevisionMigrationUrl,
      BOTTEGA_TEST_DOC_REVISION_MIGRATION_SUPERUSER_URL: docRevisionMigrationSuperuserUrl,
    },
  )
  if (docRevisionMigration !== 0) throw new EarlyExit(docRevisionMigration)

  const docAuthorMigration = await run(
    [
      'bun',
      'test',
      '--timeout',
      '30000',
      'src/postgres/postgres-migrate-doc-revision-author.test.ts',
    ],
    {
      BOTTEGA_TEST_DOC_AUTHOR_MIGRATION_URL: docAuthorMigrationUrl,
      BOTTEGA_TEST_DOC_AUTHOR_MIGRATION_SUPERUSER_URL: docAuthorMigrationSuperuserUrl,
    },
  )
  if (docAuthorMigration !== 0) throw new EarlyExit(docAuthorMigration)

  const workflowCatalogue = await run(
    ['bun', 'test', '--timeout', '30000', 'src/record/record-workflow-catalogue-postgres.test.ts'],
    { BOTTEGA_TEST_WORKFLOW_CATALOGUE_URL: workflowCatalogueUrl },
  )
  const lensCatalogue = await run(
    ['bun', 'test', '--timeout', '30000', 'src/record/record-lens-catalogue-postgres.test.ts'],
    { BOTTEGA_TEST_LENS_CATALOGUE_URL: lensCatalogueUrl },
  )
  const portCatalogue = await run(
    ['bun', 'test', '--timeout', '30000', 'src/record/record-port-catalogue-postgres.test.ts'],
    { BOTTEGA_TEST_PORT_CATALOGUE_URL: portCatalogueUrl },
  )
  if (workflowCatalogue !== 0 || lensCatalogue !== 0 || portCatalogue !== 0)
    throw new EarlyExit(workflowCatalogue || lensCatalogue || portCatalogue)

  const rls = await run(
    ['bun', 'test', '--timeout', '60000', 'src/postgres/postgres-migrate-rls.test.ts'],
    {
      BOTTEGA_TEST_POSTGRES_CONTAINER: container,
      BOTTEGA_RECORD_MIGRATE_URL: ownerUrl,
      BOTTEGA_RECORD_URL: actorUrl,
      RECORD_AUTH_DATABASE_URL: authUrl,
      BOTTEGA_TEST_POSTGRES_FALSIFY: falsifyMode,
    },
  )
  if (rls !== 0) process.exitCode = rls
  else if (!falsifyMode) {
    const readOnlyMembership = await run(
      ['bun', 'test', '--timeout', '30000', 'src/postgres/postgres-migrate-read-only.test.ts'],
      {
        BOTTEGA_TEST_POSTGRES_CONTAINER: container,
        BOTTEGA_RECORD_MIGRATE_URL: ownerUrl,
        BOTTEGA_RECORD_URL: actorUrl,
      },
    )
    if (readOnlyMembership !== 0) process.exitCode = readOnlyMembership
    else {
      const remigrate = await run(['bun', 'src/cli/orch.ts', 'record', 'migrate'], {
        BOTTEGA_RECORD_API_URL: RECORD_API_URL,
        BOTTEGA_RECORD_MIGRATE_URL: ownerUrl,
      })
      if (remigrate !== 0) process.exitCode = remigrate
      else {
        const catalogueImport = await run(
          [
            'bun',
            'test',
            '--timeout',
            '30000',
            'src/record/record-catalogue-import-postgres.test.ts',
          ],
          {
            BOTTEGA_TEST_CATALOGUE_IMPORT_URL: actorUrl,
            BOTTEGA_TEST_CATALOGUE_IMPORT_SETUP_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
          },
        )
        if (catalogueImport !== 0) throw new EarlyExit(catalogueImport)
        const runTaskReference = await run(
          ['bun', 'test', '--timeout', '30000', 'src/record/record-sync-service.test.ts'],
          {
            BOTTEGA_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
            BOTTEGA_RECORD_URL: actorUrl,
          },
        )
        if (runTaskReference !== 0) throw new EarlyExit(runTaskReference)
        const jsonbBinding = await run(
          [
            'bun',
            'test',
            '--timeout',
            '30000',
            'src/postgres/postgres-migrate-jsonb-binding.test.ts',
          ],
          {
            BOTTEGA_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
            BOTTEGA_RECORD_URL: actorUrl,
          },
        )
        if (jsonbBinding !== 0) process.exitCode = jsonbBinding
        else {
          const evidence = await run(['bun', 'run', '--cwd', '../hub', 'test:postgres'], {
            BOTTEGA_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
            BOTTEGA_RECORD_URL: actorUrl,
            RECORD_AUTH_DATABASE_URL: authUrl,
          })
          if (evidence !== 0) process.exitCode = evidence
          else if (!withoutLiveImport)
            process.exitCode = await run(
              [
                'bun',
                'test',
                '--timeout',
                String(LIVE_COPY_PHASE_TIMEOUT_MS),
                'src/postgres/postgres-import.test.ts',
              ],
              {
                BOTTEGA_TEST_POSTGRES_CONTAINER: container,
                BOTTEGA_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
                BOTTEGA_RECORD_MIGRATE_URL: ownerUrl,
                BOTTEGA_RECORD_URL: actorUrl,
                RECORD_AUTH_DATABASE_URL: authUrl,
                BOTTEGA_TEST_SOURCE_ORCH_DB: sourceOrchDb,
                BOTTEGA_TEST_SOURCE_HUB_DB: sourceHubDb,
              },
            )
        }
      }
    }
  }
} catch (error) {
  if (error instanceof EarlyExit) process.exitCode = error.code
  else throw error
} finally {
  release()
  process.off('SIGINT', signalHandlers.SIGINT)
  process.off('SIGTERM', signalHandlers.SIGTERM)
}
