import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const recordFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record')
const migrationsFolder = join(recordFolder, 'migrations')

export const postgresSchema =
  [
    'schema.ts',
    'schema-auth.ts',
    'schema-run.ts',
    'schema-question.ts',
    'schema-review.ts',
    'schema-landing.ts',
    'schema-hub.ts',
    'schema-snapshots.ts',
    'schema-config.ts',
    'schema-board.ts',
    'schema-subjects.ts',
  ]
    .map((file) => readFileSync(join(recordFolder, file), 'utf8'))
    .join('\n') + readFileSync(join(recordFolder, 'schema-docs.ts'), 'utf8')

export const migration = readdirSync(migrationsFolder, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((folder) => existsSync(join(migrationsFolder, folder, 'migration.sql')))
  .sort()
  .map((folder) => readFileSync(join(migrationsFolder, folder, 'migration.sql'), 'utf8'))
  .join('\n')

export type PsqlResult = { code: number; stdout: string; stderr: string }

export function psql(user: string, password: string, source: string): PsqlResult {
  if (!container) throw new Error('ORCH_TEST_POSTGRES_CONTAINER is required')
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${password}`,
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      user,
      '-d',
      'postgres',
      '-X',
      '-A',
      '-t',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdin: new Blob([source]), stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

export function succeeds(user: string, password: string, source: string): string {
  const result = psql(user, password, source)
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout
}

export function asSpace(
  user: string,
  password: string,
  spaceId: string,
  statement: string,
): PsqlResult {
  return psql(
    user,
    password,
    `SET app.space_id = '${spaceId}';
SELECT user_id::text AS actor_user_id FROM membership
  WHERE space_id = '${spaceId}' AND permission = 'write'
  ORDER BY created_at LIMIT 1 \\gset
SET app.user_id = :'actor_user_id';
${statement}`,
  )
}

export function asSpaces(
  user: string,
  password: string,
  activeSpaceId: string,
  spaceIds: string[],
  statement: string,
): PsqlResult {
  return psql(
    user,
    password,
    `SET app.space_id = '${activeSpaceId}';
SET app.space_ids = '${spaceIds.join(',')}';
SELECT user_id::text AS actor_user_id FROM membership
  WHERE space_id = '${activeSpaceId}' AND permission = 'write'
  ORDER BY created_at LIMIT 1 \\gset
SET app.user_id = :'actor_user_id';
${statement}`,
  )
}
