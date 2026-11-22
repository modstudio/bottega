import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(
  new URL(
    './migrations/20261122220000_dev_2592_settings_subagent_hooks_backfill/migration.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('--> statement-breakpoint', '')

test('settings subagent hook backfill preserves options and is idempotent', async () => {
  const database = new PGlite()
  await database.exec(`
    CREATE TABLE doc(scope text NOT NULL, body text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE doc_revision(scope text NOT NULL, body text NOT NULL);
    INSERT INTO doc(scope,body) VALUES
      ('settings','{"permissions":{},"hooks":{},"options":{"other":"kept"}}'),
      ('canon','{"options":{"other":"untouched"}}');
    INSERT INTO doc_revision(scope,body) VALUES
      ('settings','{"permissions":{},"hooks":{}}'),
      ('canon','{"options":{"other":"untouched"}}');
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
  `)
  await database.exec(migration)
  const once = await database.query<{ scope: string; body: string }>(
    'SELECT scope,body FROM doc ORDER BY scope',
  )
  await database.exec(migration)
  expect((await database.query('SELECT scope,body FROM doc ORDER BY scope')).rows).toEqual(
    once.rows,
  )
  expect(once.rows).toEqual([
    { scope: 'canon', body: '{"options":{"other":"untouched"}}' },
    {
      scope: 'settings',
      body: '{"hooks": {}, "options": {"other": "kept", "subagentHooks": "on"}, "permissions": {}}',
    },
  ])
  expect((await database.query('SELECT body FROM doc_revision ORDER BY scope')).rows).toEqual([
    { body: '{"options":{"other":"untouched"}}' },
    { body: '{"hooks": {}, "options": {"subagentHooks": "on"}, "permissions": {}}' },
  ])
  await database.close()
})
