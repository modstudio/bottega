import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, migrationJournal } from '../database/migrations.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  forkStepCatalogueLocal,
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  resolvedStepCatalogueVersions,
  showStepCatalogue,
  validateStepCatalogue,
} from './step-catalogue.ts'
import { mergeSeededSteps, seedMayPromote } from './workflow-built-ins.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import {
  listResolvedWorkflows,
  resolvedWorkflowVersions,
  showResolvedWorkflow,
  validateWorkflowDefinition,
} from './workflows.ts'

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
})

test('a bound store does not seed NULL-space workflow catalogue rows', () => {
  const d = database()
  d.exec(`
    DELETE FROM workflow_event;
    DELETE FROM workflow_version;
    DELETE FROM workflow;
    DELETE FROM step_catalogue_event;
    DELETE FROM step_catalogue_version;
    DELETE FROM step_catalogue;
    INSERT INTO record_install_binding(id,bound_at) VALUES (1,'2026-10-23T00:00:00.000Z');
  `)

  seedWorkflows(d)

  for (const table of [
    'workflow',
    'workflow_version',
    'workflow_event',
    'step_catalogue',
    'step_catalogue_version',
    'step_catalogue_event',
  ]) {
    expect(d.query(`SELECT COUNT(*) n FROM ${table} WHERE space_id IS NULL`).get()).toEqual({
      n: 0,
    })
  }
})

describe('seedMayPromote', () => {
  test('higher revision, no operator promotion → may promote (catches breaking bootstrap upgrades)', () => {
    expect(
      seedMayPromote({ seedRevision: 5, storedSeedRevision: 4, operatorPromoted: false }),
    ).toBe(true)
  })

  test('higher revision, operator promotion exists → may not (catches the override)', () => {
    expect(seedMayPromote({ seedRevision: 5, storedSeedRevision: 4, operatorPromoted: true })).toBe(
      false,
    )
  })

  test('equal or lower revision → may not (catches re-promoting the same seed)', () => {
    expect(
      seedMayPromote({ seedRevision: 4, storedSeedRevision: 4, operatorPromoted: false }),
    ).toBe(false)
    expect(
      seedMayPromote({ seedRevision: 3, storedSeedRevision: 4, operatorPromoted: false }),
    ).toBe(false)
  })
})

describe('seeded step merge', () => {
  test('a store-promoted step absent from the seed survives the merge (catches reverting to replacement)', () => {
    expect(
      mergeSeededSteps(
        [
          { slug: 'seeded', body: 'old' },
          { slug: 'operator-step', body: 'operator' },
        ],
        [{ slug: 'seeded', body: 'new' }],
      ),
    ).toContainEqual({ slug: 'operator-step', body: 'operator' })
  })

  test("a seeded slug present in production is replaced by the seed's body (catches skipping updates)", () => {
    expect(
      mergeSeededSteps([{ slug: 'seeded', body: 'old' }], [{ slug: 'seeded', body: 'new' }]),
    ).toEqual([{ slug: 'seeded', body: 'new' }])
  })

  test('a seeded slug absent from production is appended (catches dropping new seed steps)', () => {
    expect(
      mergeSeededSteps(
        [{ slug: 'existing', body: 'existing' }],
        [
          { slug: 'existing', body: 'updated' },
          { slug: 'new-seed', body: 'new' },
        ],
      ),
    ).toEqual([
      { slug: 'existing', body: 'updated' },
      { slug: 'new-seed', body: 'new' },
    ])
  })

  test('order of existing steps is preserved (catches reordering the tree mirror)', () => {
    expect(
      mergeSeededSteps(
        [
          { slug: 'operator-first', body: 'operator' },
          { slug: 'seeded-second', body: 'old' },
          { slug: 'operator-third', body: 'operator' },
        ],
        [{ slug: 'seeded-second', body: 'new' }],
      ).map((step) => step.slug),
    ).toEqual(['operator-first', 'seeded-second', 'operator-third'])
  })
})

describe('workflow projection and seeds', () => {
  const workflowId = (d: Database, slug: string) =>
    (d.query('SELECT record_id FROM workflow WHERE slug=?').get(slug) as { record_id: string })
      .record_id
  const events = (d: Database, slug: string) =>
    d
      .query(
        `SELECT event.version_n,event.event,event.author,event.reason,event.session_id,event.at
           FROM workflow_event event
           JOIN workflow_version version ON version.record_id=event.workflow_version_record_id
          WHERE version.workflow_record_id=? ORDER BY event.at,event.record_id`,
      )
      .all(workflowId(d, slug)) as {
      version_n: number
      event: string
      author: string
      reason: string
      session_id: string | null
      at: string
    }[]
  const makeLegacy = (d: Database, slug: string, n: number, author = 'seed') => {
    const id = workflowId(d, slug),
      definition = JSON.stringify(showResolvedWorkflow(slug, 1, null, d).definition),
      at = '2026-01-01T00:00:00.000Z'
    d.query(
      'DELETE FROM workflow_event WHERE workflow_version_record_id IN (SELECT record_id FROM workflow_version WHERE workflow_record_id=?)',
    ).run(id)
    d.query('DELETE FROM workflow_version WHERE workflow_record_id=?').run(id)
    const versionIds = new Map<number, string>()
    for (let version = 1; version <= n; version++) {
      const versionId = newRecordId()
      versionIds.set(version, versionId)
      d.query(
        `INSERT INTO workflow_version (record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at,retired_at) VALUES (?,?,?, ?,?,?,?, ?,?,?)`,
      ).run(
        versionId,
        id,
        version,
        version === n ? 'production' : 'retired',
        definition,
        version === n ? author : 'seed',
        version === 1 ? 'DEV-257 seed' : 'operator edit',
        at,
        version === n ? at : null,
        version === n ? null : at,
      )
    }
    d.query(
      `INSERT INTO workflow_event (record_id,workflow_version_record_id,version_n,event,author,reason,session_id,at) VALUES (?,?,1,'set','seed','DEV-257 seed',NULL,?)`,
    ).run(newRecordId(), versionIds.get(1)!, at)
    if (n > 1)
      d.query(
        `INSERT INTO workflow_event (record_id,workflow_version_record_id,version_n,event,author,reason,session_id,at) VALUES (?,?,?,'set',?,'operator edit',NULL,?)`,
      ).run(newRecordId(), versionIds.get(n)!, n, author, at)
  }
  test('fresh stores seed current revisions as production version 1', () => {
    const d = database()
    const catalogue = productionStepCatalogue(d)
    expect(catalogue.reason).toBe('seed r6')
    expect(validateStepCatalogue(catalogue.definition)).toEqual([])
    expect(catalogue.definition.steps.map(({ slug }) => slug)).toEqual([
      'diagnose',
      'fix-defect-fix',
      'verify',
      'blast-radius',
      'fix-defect-triage',
      'ship',
    ])
    expect(listResolvedWorkflows(null, d).map(({ slug }) => slug)).toEqual(['fix-defect'])
    for (const row of d
      .query<{ record_id: string }, []>(
        'SELECT record_id FROM workflow UNION ALL SELECT record_id FROM step_catalogue',
      )
      .all()) {
      expect(row.record_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
    for (const [slug, revision] of [['fix-defect', 5]] as const) {
      const version = showResolvedWorkflow(slug, 1, null, d)
      expect(version.status).toBe('production')
      expect(version.author).toBe('seed')
      expect(version.reason).toBe(`seed r${revision}`)
      expect(
        events(d, slug).map(({ version_n, event, author, reason, session_id }) => ({
          version_n,
          event,
          author,
          reason,
          session_id,
        })),
      ).toEqual([
        {
          version_n: 1,
          event: 'set',
          author: 'seed',
          reason: `seed r${revision}`,
          session_id: null,
        },
      ])
      expect(validateWorkflowDefinition(version.definition)).toEqual([])
      expect(version.definition.modes[0]?.steps.at(-1)).toBe('ship')
      expect(catalogue.definition.steps.find(({ slug }) => slug === 'ship')?.body).toContain(
        '`ship-task` workflow',
      )
    }
  })
  test('catalogue seed revision advances an existing seed store to the ship-task wording', () => {
    const d = database(),
      catalogue = productionStepCatalogue(d),
      legacy = {
        steps: catalogue.definition.steps.map((step) => {
          if (step.slug === 'ship')
            return { ...step, body: step.body.replace('`ship-task`', '`ship`') }
          return step
        }),
      }
    d.query(
      "UPDATE step_catalogue_version SET definition=?,reason='seed r5' WHERE catalogue_record_id=? AND n=1",
    ).run(JSON.stringify(legacy), catalogue.owner_record_id)
    d.query(
      "UPDATE step_catalogue_event SET reason='seed r5' WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?) AND author='seed'",
    ).run(catalogue.owner_record_id)

    seedWorkflows(d)

    expect(showStepCatalogue(1, d).status).toBe('retired')
    const advanced = showStepCatalogue(2, d)
    expect(advanced.status).toBe('production')
    expect(advanced.reason).toBe('seed r6')
    expect(advanced.definition.steps.find(({ slug }) => slug === 'ship')?.body).toContain(
      '`ship-task` workflow',
    )
  })
  test('forking a legacy catalogue maps old vocabulary before refusing its missing stage', () => {
    const d = database()
    const catalogue = productionStepCatalogue(d)
    const legacy = {
      steps: catalogue.definition.steps.map(({ stage: _stage, ...step }, index) => ({
        ...step,
        ...(index === 0 ? { autonomy: 'manual', floor: ['human-ruling'] } : {}),
      })),
    }
    d.query(
      'UPDATE step_catalogue_version SET definition=? WHERE catalogue_record_id=? AND n=1',
    ).run(JSON.stringify(legacy), catalogue.owner_record_id)

    let message = ''
    try {
      forkStepCatalogueLocal(1, 'operator edit', 'architect', d)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('step "diagnose" has invalid or missing stage "undefined"')
    expect(message).not.toContain('human-ruling')
    expect(message).not.toContain('manual')
  })
  test('an operator-promoted catalogue records nothing on a seed bump (catches the DEV-778 class returning by the other door)', () => {
    const d = database(),
      catalogue = productionStepCatalogue(d),
      legacy = {
        steps: catalogue.definition.steps.map((step) => {
          if (step.slug === 'ship') return { ...step, body: 'Operator-authored ship step.' }
          return step
        }),
      }
    d.query(
      'UPDATE step_catalogue_version SET definition=? WHERE catalogue_record_id=? AND n=1',
    ).run(JSON.stringify(legacy), catalogue.owner_record_id)
    const draft = forkStepCatalogueLocal(1, 'operator edit', 'architect', d)
    promoteStepCatalogueLocal(draft.n, 'operator promote', 'architect', d)
    d.query(
      "UPDATE step_catalogue_event SET reason='seed r1' WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?) AND author='seed'",
    ).run(catalogue.owner_record_id)
    const beforeVersions = resolvedStepCatalogueVersions(null, d).length,
      beforeEvents = (
        d
          .query(
            'SELECT COUNT(*) AS count FROM step_catalogue_event WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?)',
          )
          .get(catalogue.owner_record_id) as { count: number }
      ).count

    seedWorkflows(d)

    expect(resolvedStepCatalogueVersions(null, d)).toHaveLength(beforeVersions)
    expect(
      d
        .query(
          'SELECT COUNT(*) AS count FROM step_catalogue_event WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?)',
        )
        .get(catalogue.owner_record_id),
    ).toEqual({ count: beforeEvents })
    expect(productionStepCatalogue(d).n).toBe(draft.n)
    expect(productionStepCatalogue(d).author).toBe('architect')
  })
  test('an unchanged merge records no new version or event (catches promoting a duplicate on every initialize)', () => {
    const d = database(),
      catalogue = productionStepCatalogue(d),
      beforeVersions = resolvedStepCatalogueVersions(null, d).length,
      beforeEvents = (
        d
          .query(
            'SELECT COUNT(*) AS count FROM step_catalogue_event WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?)',
          )
          .get(catalogue.owner_record_id) as { count: number }
      ).count
    d.query(
      "UPDATE step_catalogue_event SET reason='seed r1' WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?) AND author='seed'",
    ).run(catalogue.owner_record_id)

    seedWorkflows(d)

    expect(resolvedStepCatalogueVersions(null, d)).toHaveLength(beforeVersions)
    expect(
      d
        .query(
          'SELECT COUNT(*) AS count FROM step_catalogue_event WHERE catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?)',
        )
        .get(catalogue.owner_record_id),
    ).toEqual({ count: beforeEvents })
  })
  test('the remaining legacy seed revision upgrades its live shape', () => {
    const d = database()
    makeLegacy(d, 'fix-defect', 1)
    seedWorkflows(d)
    expect(showResolvedWorkflow('fix-defect', 2, null, d).status).toBe('production')
    for (const [slug, prior, next, revision] of [['fix-defect', 1, 2, 5]] as const) {
      expect(showResolvedWorkflow(slug, prior, null, d).status).toBe('retired')
      expect(showResolvedWorkflow(slug, next, null, d).reason).toBe(`seed r${revision}`)
      expect(
        events(d, slug)
          .slice(-3)
          .map(({ version_n, event, author, reason, session_id, at }) => ({
            version_n,
            event,
            author,
            reason,
            session_id,
            at,
          })),
      ).toEqual([
        {
          version_n: prior,
          event: 'retire',
          author: 'seed',
          reason: `seed r${revision}`,
          session_id: null,
          at: expect.any(String),
        },
        {
          version_n: next,
          event: 'set',
          author: 'seed',
          reason: `seed r${revision}`,
          session_id: null,
          at: expect.any(String),
        },
        {
          version_n: next,
          event: 'promote',
          author: 'seed',
          reason: `seed r${revision}`,
          session_id: null,
          at: expect.any(String),
        },
      ])
    }
  })
  test('migration renames a legacy workflow in place before seeding its new revision', () => {
    const d = database()
    const id = workflowId(d, 'fix-defect')
    d.query("UPDATE workflow SET slug='filed-issue' WHERE record_id=?").run(id)
    makeLegacy(d, 'filed-issue', 2, 'architect')
    d.query("DELETE FROM orch_migrations WHERE version='0033_fix_defect_workflow'").run()
    d.exec(`PRAGMA user_version = ${migrationJournal().length - 1}`)

    applyMigrations(d)
    seedWorkflows(d)

    expect(d.query("SELECT COUNT(*) AS n FROM workflow WHERE slug='filed-issue'").get()).toEqual({
      n: 0,
    })
    expect(d.query("SELECT record_id FROM workflow WHERE slug='fix-defect'").get()).toEqual({
      record_id: id,
    })
    expect(resolvedWorkflowVersions('fix-defect', null, d).map(({ n }) => n)).toEqual([1, 2, 3])
    expect(showResolvedWorkflow('fix-defect', 2, null, d).author).toBe('architect')
    expect(showResolvedWorkflow('fix-defect', 3, null, d).reason).toBe('seed r5')
    expect(
      listResolvedWorkflows(null, d).filter(
        ({ slug }) => slug === 'fix-defect' || slug === 'filed-issue',
      ),
    ).toHaveLength(1)
  })
  test('revision seeding is idempotent', () => {
    const d = database()
    makeLegacy(d, 'fix-defect', 1)
    seedWorkflows(d)
    seedWorkflows(d)
    expect(resolvedWorkflowVersions('fix-defect', null, d).map((version) => version.n)).toEqual([
      1, 2,
    ])
    expect(resolvedStepCatalogueVersions(null, d).map((version) => version.n)).toEqual([1])
  })
  test('seed revision replaces but retains an operator production version', () => {
    const d = database()
    makeLegacy(d, 'fix-defect', 2, 'architect')
    seedWorkflows(d)
    expect(showResolvedWorkflow('fix-defect', 2, null, d).status).toBe('retired')
    expect(showResolvedWorkflow('fix-defect', 2, null, d).author).toBe('architect')
    expect(showResolvedWorkflow('fix-defect', 3, null, d).status).toBe('production')
    expect(showResolvedWorkflow('fix-defect', 3, null, d).author).toBe('seed')
  })
  test('a workflow with no production version upgrades without a retire event', () => {
    const d = database()
    makeLegacy(d, 'fix-defect', 1)
    d.query(
      "UPDATE workflow_version SET status='retired',retired_at=? WHERE status='production'",
    ).run(new Date().toISOString())
    const before = events(d, 'fix-defect').length
    seedWorkflows(d)
    expect(showResolvedWorkflow('fix-defect', 2, null, d).status).toBe('production')
    expect(
      events(d, 'fix-defect')
        .slice(before)
        .map(({ event }) => event),
    ).toEqual(['set', 'promote'])
  })
})
