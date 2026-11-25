import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydrationDrift, planHydration } from '../orchestrator/src/canon/canon-hydrate.ts'
import {
  closeDatabaseForFixture,
  DB_PATH,
  openReadOnlyDatabase,
} from '../orchestrator/src/database/db.ts'
import { writeMigratedTestDatabase } from '../orchestrator/src/database/test-database.fixture.ts'
import { currentRecordAuthorityFacts } from '../orchestrator/src/record/record-write-authority.ts'
import { installRecordApiClient } from '../orchestrator/test/fixtures/record-api.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { newRecordId } from '../shared/record-id.ts'
import { clearRecordSessionToken, writeRecordSessionToken } from '../shared/record-session.ts'
import {
  realPathForPotentialPath,
  recordSessionPath,
  resolveStateRoot,
  STATE_HOME_ENV,
  temporaryStateStoreMigrationAllowed,
} from '../shared/state-directory.ts'
import { cloneRepository, runTestGit } from '../shared/test-git-repository.ts'
import {
  branchChangedPaths,
  branchHydrationPaths,
  canonBranchFindings,
  canonEmptyStoreDriftRefusal,
  readCanonGateInput,
} from './check-canon-drift.ts'
import { resolveRegisteredLandingBase } from './landing-base.ts'

let scratch: string | null = null
const originalGithubBase = process.env.GITHUB_BASE_REF
const originalKeyStore = process.env.BOTTEGA_KEYSTORE
const originalStateHome = process.env[STATE_HOME_ENV]
const originalTestContainer = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
const originalFetch = globalThis.fetch

function git(root: string, ...args: string[]): string {
  return runTestGit(root, process.env, ...args)
}

function repository(): string {
  scratch = cloneRepository(process.env, 'canon-drift-gate-')
  return scratch
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A')
  git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

beforeAll(() => {
  process.env.BOTTEGA_RECORD_API_URL = ''
})

afterEach(() => {
  installRecordApiClient(null)
  closeDatabaseForFixture()
  scratch = null
  if (originalGithubBase === undefined) delete process.env.GITHUB_BASE_REF
  else process.env.GITHUB_BASE_REF = originalGithubBase
})

afterAll(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
})

describe('canon drift branch gate', () => {
  test('checks the Codex project doc when one of its hydrated sources changes', () => {
    const plan = planHydration({
      rows: [
        { slug: 'AGENTS.md', body: 'Entry.\n' },
        { slug: '.agents/rules/example.md', body: 'Rule.\n' },
      ],
      tree: [
        { path: 'AGENTS.md', text: 'Entry.\n' },
        { path: '.agents/rules/example.md', text: 'Rule.\n' },
        { path: 'AGENTS.override.md', text: 'stale\n' },
      ],
    })

    expect(hydrationDrift(plan, branchHydrationPaths(['.agents/rules/example.md']))).toEqual([
      { path: 'AGENTS.override.md', operation: 'write' },
    ])
  })

  test('compares committed HEAD even when the working copy matches stored canon', () => {
    const root = repository()
    writeFileSync(join(root, 'AGENTS.md'), 'stored\n')
    const base = commit(root, 'base')
    writeFileSync(join(root, 'AGENTS.md'), 'committed drift\n')
    commit(root, 'drift')
    writeFileSync(join(root, 'AGENTS.md'), 'stored\n')

    expect(
      canonBranchFindings({
        checkout: root,
        base,
        rows: [{ slug: 'AGENTS.md', body: 'stored\n', subject: null }],
      }),
    ).toEqual([
      { path: 'AGENTS.md', operation: 'write' },
      { path: 'AGENTS.override.md', operation: 'write' },
    ])
  })

  test('treats moves out of both canon namespaces as removals', () => {
    const root = repository()
    mkdirSync(join(root, '.agents/rules'), { recursive: true })
    writeFileSync(join(root, '.agents/rules/example.md'), 'rule\n')
    writeFileSync(join(root, 'AGENTS.md'), 'card\n')
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
    const base = commit(root, 'base')
    mkdirSync(join(root, '.agents/skills'), { recursive: true })
    git(root, 'mv', '.agents/rules/example.md', '.agents/skills/example.md')
    git(root, 'mv', 'CLAUDE.md', 'CLAUDE-away.md')
    commit(root, 'move canon away')

    const changed = branchChangedPaths(root, base)
    expect(changed).toContain('.agents/rules/example.md')
    expect(changed).toContain('CLAUDE.md')
    expect(
      canonBranchFindings({
        checkout: root,
        base,
        rows: [
          { slug: '.agents/rules/example.md', body: 'rule\n', subject: null },
          { slug: 'AGENTS.md', body: 'card\n', subject: null },
        ],
      }),
    ).toEqual([
      { path: '.agents/rules/example.md', operation: 'write' },
      { path: 'AGENTS.override.md', operation: 'write' },
      { path: 'CLAUDE.md', operation: 'link' },
    ])
  })

  test('reads register and canon rows without changing a scratch store', async () => {
    const root = repository()
    const store = DB_PATH
    writeMigratedTestDatabase(store)
    const writable = new Database(store, { create: true })
    writable
      .query('INSERT INTO project (record_id,name,path,canon,settings) VALUES (?,?,?,1,?)')
      .run(newRecordId(), 'fixture', root, JSON.stringify({ trunk: 'main', space: 'fixture' }))
    writable
      .query(
        `INSERT INTO doc
         (record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
         VALUES (?,'canon',NULL,'AGENTS.md','Fixture canon','Fixture canon body.','inject',?,?,?)`,
      )
      .run(newRecordId(), '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z', '["technical"]')
    writable.exec('DELETE FROM record_install_binding')
    writable
      .query("INSERT INTO record_local_by_design(record_id,mark) VALUES (?,'local')")
      .run(newRecordId())
    writable.exec('PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);')
    writable.close()
    const digest = () => createHash('sha256').update(readFileSync(store)).digest('hex')
    const before = digest()

    const readonly = openReadOnlyDatabase(store)
    try {
      expect(currentRecordAuthorityFacts(readonly)).toMatchObject({
        recordApiConfigured: false,
        installBound: false,
        localByDesign: true,
      })
      expect(await readCanonGateInput(root, readonly)).toMatchObject({
        project: { name: 'fixture' },
        rows: [{ slug: 'AGENTS.md', body: 'Fixture canon body.', subject: null }],
      })
    } finally {
      readonly.close()
    }

    expect(digest()).toBe(before)
  })

  describe('hosted-authoritative store read', () => {
    let stateHome: string

    beforeEach(() => {
      installRecordApiClient(null)
      stateHome = mkdtempSync(join(tmpdir(), 'canon-drift-record-state-'))
      process.env[STATE_HOME_ENV] = stateHome
      const realTemporaryDirectory = realPathForPotentialPath(tmpdir())
      const isolatedPaths = [resolveStateRoot(process.env), recordSessionPath(process.env)]
      if (
        !isolatedPaths.every((path) =>
          temporaryStateStoreMigrationAllowed(
            realPathForPotentialPath(path),
            realTemporaryDirectory,
          ),
        )
      ) {
        throw new Error(
          'hosted canon test state root and record session path must be under the OS temporary directory',
        )
      }
      process.env.BOTTEGA_KEYSTORE = 'file'
      process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = '1'
      process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
      writeRecordSessionToken('fixture-token')
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const body =
          url.pathname === '/v1/whoami'
            ? {
                user: {
                  id: 'user-a',
                  name: 'Fixture User',
                  email: 'fixture@example.test',
                  emailVerified: true,
                },
                activeSpaceId: 'fixture-space',
                personalSpaceId: 'personal-space',
                memberships: [
                  {
                    space_id: 'fixture-space',
                    name: 'Fixture',
                    slug: 'fixture',
                    role: 'member',
                    permission: 'write',
                  },
                ],
              }
            : {
                items:
                  url.searchParams.get('subject') === 'fixture'
                    ? [
                        {
                          id: newRecordId(),
                          scope: 'canon',
                          subject: 'fixture',
                          slug: 'AGENTS.md',
                          title: 'Hosted fixture canon',
                          body: 'Hosted fixture canon body.',
                          delivery: 'inject',
                          audiences: ['technical'],
                          status: 'current',
                          kind: 'working',
                          createdAt: '2026-11-25T00:00:00.000Z',
                          updatedAt: '2026-11-25T00:00:00.000Z',
                        },
                      ]
                    : [],
                nextCursor: null,
              }
        return Response.json(body)
      }) as typeof fetch
    })

    afterEach(() => {
      clearRecordSessionToken()
      rmSync(stateHome, { recursive: true, force: true })
      if (originalStateHome === undefined) delete process.env[STATE_HOME_ENV]
      else process.env[STATE_HOME_ENV] = originalStateHome
      globalThis.fetch = originalFetch
      if (originalKeyStore === undefined) delete process.env.BOTTEGA_KEYSTORE
      else process.env.BOTTEGA_KEYSTORE = originalKeyStore
      if (originalTestContainer === undefined) delete process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
      else process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = originalTestContainer
      process.env.BOTTEGA_RECORD_API_URL = ''
    })

    test('reads hosted canon rows without changing a scratch store', async () => {
      const root = repository()
      const store = DB_PATH
      writeMigratedTestDatabase(store)
      const writable = new Database(store, { create: true })
      writable
        .query('INSERT INTO project (record_id,name,path,canon,settings) VALUES (?,?,?,1,?)')
        .run(newRecordId(), 'fixture', root, JSON.stringify({ trunk: 'main', space: 'fixture' }))
      writable.exec('DELETE FROM record_local_by_design; DELETE FROM record_install_binding;')
      writable
        .query(
          "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-25',?)",
        )
        .run('https://record.example.test')
      writable.exec('PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);')
      writable.close()
      const digest = () => createHash('sha256').update(readFileSync(store)).digest('hex')
      const before = digest()

      const readonly = openReadOnlyDatabase(store)
      try {
        expect(await readCanonGateInput(root, readonly)).toMatchObject({
          project: { name: 'fixture' },
          rows: [{ slug: 'AGENTS.md', body: 'Hosted fixture canon body.', subject: 'fixture' }],
        })
      } finally {
        readonly.close()
      }

      expect(digest()).toBe(before)
    })
  })

  test('refuses CI base metadata that differs from registered trunk', () => {
    process.env.GITHUB_BASE_REF = 'release'
    expect(() => resolveRegisteredLandingBase('/unused', 'canon drift check', 'main')).toThrow(
      'GITHUB_BASE_REF release: the project register names main as trunk',
    )
  })

  test('an empty project store names import as the remedy instead of hydrate', () => {
    expect(canonEmptyStoreDriftRefusal({ projectRowCount: 0, deleteCount: 1 })).toEqual({
      condition: 'this store holds no project canon while the tree has managed canon paths',
      remedy: `${PLATFORM_SLUG} doc canon import --project`,
    })
    expect(canonEmptyStoreDriftRefusal({ projectRowCount: 1, deleteCount: 1 })).toBeNull()
  })
})
