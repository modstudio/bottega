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
    CREATE TABLE doc(
      id text PRIMARY KEY, space_id text NOT NULL DEFAULT 'space', scope text NOT NULL,
      subject text, owner_user_id text, slug text NOT NULL, project_id text, title text NOT NULL DEFAULT 'title',
      body text NOT NULL, delivery text NOT NULL DEFAULT 'demand', audiences text[] NOT NULL DEFAULT ARRAY['technical'],
      featured boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'current', kind text NOT NULL DEFAULT 'working',
      form text, article_subject_id text, source_files jsonb NOT NULL DEFAULT '[]', checked_against_commit text,
      summary text, replacement_slug text, parent_id text, position integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(), latest_revision_id text
    );
    CREATE TABLE doc_revision(
      id text PRIMARY KEY, space_id text NOT NULL, doc_id text NOT NULL, scope text NOT NULL,
      subject text, owner_user_id text, slug text NOT NULL, project_id text, op text NOT NULL,
      title text NOT NULL, body text NOT NULL, delivery text NOT NULL, audiences text[] NOT NULL,
      featured boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'current', kind text NOT NULL DEFAULT 'working',
      form text, article_subject_id text, source_files jsonb NOT NULL DEFAULT '[]', checked_against_commit text,
      summary text, replacement_slug text, parent_id text, position integer NOT NULL DEFAULT 0,
      author text NOT NULL, reason text NOT NULL, at timestamptz NOT NULL
    );
    INSERT INTO doc(id,scope,slug,body) VALUES
      ('valid','settings','valid','{"permissions":{},"hooks":{},"options":{"other":"kept"}}'),
      ('invalid-json','settings','invalid-json','not json at all'),
      ('invalid-unicode','settings','invalid-unicode','{"hooks":{"c":"a\\u0000b"}}'),
      ('scalar','settings','scalar','5'),
      ('array-options','settings','array-options','{"options":[1,2]}'),
      ('null-options','settings','null-options','{"options":null}'),
      ('canon','canon','canon','{"options":{"other":"untouched"}}');
    INSERT INTO doc_revision(id,space_id,doc_id,scope,slug,op,title,body,delivery,audiences,author,reason,at) VALUES
      ('old-valid','space','valid','settings','valid','create','title','{"permissions":{},"hooks":{}}','demand',ARRAY['technical'],'operator','original','2026-01-01'),
      ('old-canon','space','canon','canon','canon','create','title','{"options":{"other":"untouched"}}','demand',ARRAY['technical'],'operator','original','2026-01-01');
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
  `)
  await database.exec(migration)
  const once = await database.query<{ id: string; scope: string; body: string }>(
    'SELECT id,scope,body FROM doc ORDER BY id',
  )
  await database.exec(migration)
  expect((await database.query('SELECT id,scope,body FROM doc ORDER BY id')).rows).toEqual(
    once.rows,
  )
  expect(once.rows).toEqual([
    { id: 'array-options', scope: 'settings', body: '{"options":[1,2]}' },
    { id: 'canon', scope: 'canon', body: '{"options":{"other":"untouched"}}' },
    { id: 'invalid-json', scope: 'settings', body: 'not json at all' },
    {
      id: 'invalid-unicode',
      scope: 'settings',
      body: '{"hooks":{"c":"a\\u0000b"}}',
    },
    { id: 'null-options', scope: 'settings', body: '{"options":null}' },
    { id: 'scalar', scope: 'settings', body: '5' },
    {
      id: 'valid',
      scope: 'settings',
      body: '{"hooks": {}, "options": {"other": "kept", "subagentHooks": "on"}, "permissions": {}}',
    },
  ])
  expect(
    (
      await database.query(
        'SELECT doc_id,op,author,reason,body FROM doc_revision ORDER BY doc_id,at',
      )
    ).rows,
  ).toEqual([
    {
      doc_id: 'canon',
      op: 'create',
      author: 'operator',
      reason: 'original',
      body: '{"options":{"other":"untouched"}}',
    },
    {
      doc_id: 'valid',
      op: 'create',
      author: 'operator',
      reason: 'original',
      body: '{"permissions":{},"hooks":{}}',
    },
    {
      doc_id: 'valid',
      op: 'backfill',
      author: 'migration',
      reason: 'DEV-2592: subagent blocking stays on for existing users',
      body: '{"hooks": {}, "options": {"other": "kept", "subagentHooks": "on"}, "permissions": {}}',
    },
  ])
  await database.close()
})
