import { beforeAll, expect, test } from 'bun:test'
import { RECORD_ACTOR_ROLE, RECORD_PUBLIC_ROLE } from '../../shared/record/schema.ts'
import { upsertRecordDoc } from '../src/record/record-docs.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

const PUBLIC_DOC = '01990000-0000-7000-8000-00000000030a'
const TECHNICAL_DOC = '01990000-0000-7000-8000-00000000030b'
const OWNED_DOC = '01990000-0000-7000-8000-00000000030c'
const DELETED_DOC = '01990000-0000-7000-8000-00000000030d'
const PRIVATE_SPACE_DOC = '01990000-0000-7000-8000-00000000030e'
const OTHER_PROJECT_DOC = '01990000-0000-7000-8000-00000000030f'
const NO_PROJECT_DOC = '01990000-0000-7000-8000-000000000310'

export function registerPublicDocProofs(input: {
  spaces: readonly [publicSpaceId: string, privateSpaceId: string, actorUrl: string]
  projects: readonly [publicProjectId: string, otherProjectId: string, privateProjectId: string]
  ownerUserId: string
  admin(statement: string): string
  psql(user: string, password: string, statement: string): PsqlResult
}): void {
  const [publicSpaceId, privateSpaceId, actorUrl] = input.spaces
  const [publicProjectId, otherProjectId, privateProjectId] = input.projects
  const asPublic = (statement: string) =>
    input.psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `BEGIN; SET LOCAL ROLE ${RECORD_PUBLIC_ROLE}; ${statement}`,
    )

  beforeAll(() => {
    input.admin(`
      INSERT INTO public_doc_space (space_id, project_id)
        VALUES ('${publicSpaceId}', '${publicProjectId}');
      INSERT INTO doc (
        id, space_id, scope, subject, owner_user_id, slug, title, body, delivery,
        audience, featured, project_id, created_at, updated_at, deleted_at
      ) VALUES
        ('${PUBLIC_DOC}', '${publicSpaceId}', 'global', NULL, NULL,
         'public-guide', 'Public guide', 'public searchable body', 'demand', 'user', true, '${publicProjectId}', now(), now(), NULL),
        ('${TECHNICAL_DOC}', '${publicSpaceId}', 'global', NULL, NULL,
         'technical-guide', 'Technical guide', 'hidden technical body', 'demand', 'technical', false, '${publicProjectId}', now(), now(), NULL),
        ('${OWNED_DOC}', '${publicSpaceId}', 'canon', NULL, '${input.ownerUserId}',
         'owned-guide', 'Owned guide', 'hidden owned body', 'demand', 'user', false, '${publicProjectId}', now(), now(), NULL),
        ('${DELETED_DOC}', '${publicSpaceId}', 'global', NULL, NULL,
         'deleted-guide', 'Deleted guide', 'hidden deleted body', 'demand', 'user', false, '${publicProjectId}', now(), now(), now()),
        ('${PRIVATE_SPACE_DOC}', '${privateSpaceId}', 'global', NULL, NULL,
         'private-guide', 'Private guide', 'hidden private body', 'demand', 'user', false, '${privateProjectId}', now(), now(), NULL),
        ('${OTHER_PROJECT_DOC}', '${publicSpaceId}', 'global', NULL, NULL,
         'other-project-guide', 'Other project guide', 'hidden other project body', 'demand', 'user', false, '${otherProjectId}', now(), now(), NULL),
        ('${NO_PROJECT_DOC}', '${publicSpaceId}', 'global', NULL, NULL,
         'no-project-guide', 'No project guide', 'hidden no project body', 'demand', 'user', false, NULL, now(), now(), NULL);
    `)
  })

  test('record public sees only live unowned user docs in the designated project', () => {
    const result = asPublic('SELECT id FROM doc ORDER BY id; COMMIT;')
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(PUBLIC_DOC)
  })

  test('record public can read featured on a public document', () => {
    const result = asPublic(`SELECT featured FROM doc WHERE id='${PUBLIC_DOC}'; COMMIT;`)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('t')
  })

  test('record service refuses attaching another project address to the public project', async () => {
    await expect(
      upsertRecordDoc({
        url: actorUrl,
        userId: input.ownerUserId,
        spaceId: publicSpaceId,
        scope: 'project',
        subject: 'alpha-two',
        slug: 'mismatched-project',
        title: 'Mismatched project',
        body: 'must never become public',
        delivery: 'demand',
        audience: 'user',
        projectName: 'alpha',
        reason: 'prove project/address consistency',
        author: 'postgres proof',
      }),
    ).rejects.toThrow('document project "alpha" does not match address project "alpha-two"')
  })

  test('record public has no access to any other table', () => {
    for (const table of ['doc_revision', 'run', 'space', 'project']) {
      const result = asPublic(`SELECT count(*) FROM ${table}; ROLLBACK;`)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(`permission denied for table ${table}`)
    }
  })

  test('record public is no-login and has grants only on public document data', () => {
    const facts = input.admin(`
      SELECT rolcanlogin FROM pg_roles WHERE rolname='${RECORD_PUBLIC_ROLE}';
      SELECT table_name || '|' || privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee='${RECORD_PUBLIC_ROLE}' AND table_schema='public'
      ORDER BY table_name, privilege_type;
      SELECT DISTINCT table_name
      FROM information_schema.role_column_grants
      WHERE grantee='${RECORD_PUBLIC_ROLE}' AND table_schema='public'
      ORDER BY table_name;
    `)
    // A table-level grant also appears per column, so the designation table is listed twice.
    expect(facts.split('\n')).toEqual(['f', 'public_doc_space|SELECT', 'doc', 'public_doc_space'])
  })

  test('record public cannot write docs or the designation table', () => {
    const docWrite = asPublic(`UPDATE doc SET title='changed' WHERE id='${PUBLIC_DOC}'; ROLLBACK;`)
    expect(docWrite.code).not.toBe(0)
    expect(docWrite.stderr).toContain('permission denied for table doc')

    const designationWrite = asPublic(
      `INSERT INTO public_doc_space (space_id, project_id) VALUES ('${privateSpaceId}', '${privateProjectId}'); ROLLBACK;`,
    )
    expect(designationWrite.code).not.toBe(0)
    expect(designationWrite.stderr).toContain('permission denied for table public_doc_space')
  })

  test('record actor does not inherit public visibility', () => {
    const result = input.psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SET app.space_id='${privateSpaceId}'; SELECT id FROM doc WHERE id='${PUBLIC_DOC}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('')
  })

  test('record actor can read but cannot write the designation table', () => {
    const read = input.psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SELECT space_id || '|' || project_id FROM public_doc_space WHERE space_id='${publicSpaceId}';`,
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout).toBe(`${publicSpaceId}|${publicProjectId}`)

    const write = input.psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `INSERT INTO public_doc_space (space_id, project_id) VALUES ('${privateSpaceId}', '${privateProjectId}');`,
    )
    expect(write.code).not.toBe(0)
    expect(write.stderr).toContain('permission denied for table public_doc_space')
  })
}
