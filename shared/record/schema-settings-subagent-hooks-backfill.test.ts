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
    CREATE TABLE doc(label text NOT NULL, scope text NOT NULL, body text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE doc_revision(label text NOT NULL, scope text NOT NULL, body text NOT NULL);
    INSERT INTO doc(label,scope,body) VALUES
      ('valid','settings','{"permissions":{},"hooks":{},"options":{"other":"kept"}}'),
      ('invalid-json','settings','not json at all'),
      ('scalar','settings','5'),
      ('array-options','settings','{"options":[1,2]}'),
      ('null-options','settings','{"options":null}'),
      ('canon','canon','{"options":{"other":"untouched"}}');
    INSERT INTO doc_revision(label,scope,body) VALUES
      ('valid','settings','{"permissions":{},"hooks":{}}'),
      ('invalid-json','settings','not json at all'),
      ('scalar','settings','5'),
      ('array-options','settings','{"options":[1,2]}'),
      ('null-options','settings','{"options":null}'),
      ('canon','canon','{"options":{"other":"untouched"}}');
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
  `)
  await database.exec(migration)
  const once = await database.query<{ label: string; scope: string; body: string }>(
    'SELECT label,scope,body FROM doc ORDER BY label',
  )
  await database.exec(migration)
  expect((await database.query('SELECT label,scope,body FROM doc ORDER BY label')).rows).toEqual(
    once.rows,
  )
  expect(once.rows).toEqual([
    { label: 'array-options', scope: 'settings', body: '{"options":[1,2]}' },
    { label: 'canon', scope: 'canon', body: '{"options":{"other":"untouched"}}' },
    { label: 'invalid-json', scope: 'settings', body: 'not json at all' },
    { label: 'null-options', scope: 'settings', body: '{"options":null}' },
    { label: 'scalar', scope: 'settings', body: '5' },
    {
      label: 'valid',
      scope: 'settings',
      body: '{"hooks": {}, "options": {"other": "kept", "subagentHooks": "on"}, "permissions": {}}',
    },
  ])
  expect((await database.query('SELECT label,body FROM doc_revision ORDER BY label')).rows).toEqual(
    [
      { label: 'array-options', body: '{"options":[1,2]}' },
      { label: 'canon', body: '{"options":{"other":"untouched"}}' },
      { label: 'invalid-json', body: 'not json at all' },
      { label: 'null-options', body: '{"options":null}' },
      { label: 'scalar', body: '5' },
      {
        label: 'valid',
        body: '{"hooks": {}, "options": {"subagentHooks": "on"}, "permissions": {}}',
      },
    ],
  )
  await database.close()
})
