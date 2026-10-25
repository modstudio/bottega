// concern: workflows
/** Knows the built-in workflow definitions and advances them by seed revision.
 * Must not know workflow commands, adapters, execution, or project state. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { validateStepCatalogue } from './step-catalogue.ts'
import {
  BUILT_IN_WORKFLOW_AUTHOR,
  catalogueDefinition,
  mergeSeededSteps,
  type SeedCatalogueStep,
  seedMayPromote,
  workflowSeeds as seeds,
  workflowDefinition,
} from './workflow-built-ins.ts'

const seedDefinition = JSON.stringify

function seedCatalogueEvent(
  d: Database,
  catalogueId: string,
  n: number,
  event: 'set' | 'promote' | 'retire',
  reason: string,
  now: string,
): void {
  d.query(`INSERT INTO step_catalogue_event
    (record_id,catalogue_version_record_id,version_n,event,author,reason,session_id,at)
    VALUES (?,(SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=? AND n=? AND superseded_at IS NULL),?,?,?,?,NULL,?)`).run(
    newRecordId(),
    catalogueId,
    n,
    n,
    event,
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
  )
}

function seedWorkflowEvent(
  d: Database,
  workflowId: string,
  n: number,
  event: 'set' | 'promote' | 'retire',
  reason: string,
  now: string,
): void {
  d.query(`INSERT INTO workflow_event
    (record_id,workflow_version_record_id,version_n,event,author,reason,session_id,at)
    VALUES (?,(SELECT record_id FROM workflow_version WHERE workflow_record_id=? AND n=? AND superseded_at IS NULL),?,?,?,?,NULL,?)`).run(
    newRecordId(),
    workflowId,
    n,
    n,
    event,
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
  )
}

function seedCatalogue(d: Database, now: string): void {
  const seeded = catalogueDefinition(),
    seededDefinition = JSON.stringify(seeded),
    revision = 6,
    reason = `seed r${revision}`
  requireValidSeedCatalogue(seeded)
  let catalogue = d
    .query("SELECT record_id FROM step_catalogue WHERE slug='shared' AND space_id IS NULL")
    .get() as {
    record_id: string
  } | null
  if (!catalogue) {
    catalogue = d
      .query(
        "INSERT INTO step_catalogue (record_id,slug,created_at) VALUES (?,'shared',?) RETURNING record_id",
      )
      .get(newRecordId(), now) as { record_id: string }
    d.query(
      `INSERT INTO step_catalogue_version (record_id,catalogue_record_id,n,status,definition,author,reason,created_at,promoted_at) VALUES (?,?,1,'production',?,?,?,?,?)`,
    ).run(
      newRecordId(),
      catalogue.record_id,
      seededDefinition,
      BUILT_IN_WORKFLOW_AUTHOR,
      reason,
      now,
      now,
    )
    seedCatalogueEvent(d, catalogue.record_id, 1, 'set', reason, now)
    return
  }
  if (
    !seedMayPromote({
      seedRevision: revision,
      storedSeedRevision: storedCatalogueSeedRevision(d, catalogue.record_id),
      operatorPromoted: operatorPromotedCatalogue(d, catalogue.record_id),
    })
  )
    return
  const prior = d
    .query(
      "SELECT n,definition FROM step_catalogue_version WHERE catalogue_record_id=? AND status='production' AND superseded_at IS NULL",
    )
    .get(catalogue.record_id) as { n: number; definition: string } | null
  const assembled = prior
    ? {
        steps: mergeSeededSteps(
          (JSON.parse(prior.definition) as { steps: SeedCatalogueStep[] }).steps,
          seeded.steps,
        ),
        ...((JSON.parse(prior.definition) as { sequences?: unknown }).sequences === undefined
          ? {}
          : {
              sequences: (JSON.parse(prior.definition) as { sequences: unknown }).sequences,
            }),
      }
    : seeded
  requireValidSeedCatalogue(assembled)
  const definition = JSON.stringify(assembled)
  if (prior?.definition === definition) return
  const { n: maxN } = d
    .query(
      'SELECT COALESCE(MAX(n),0) AS n FROM step_catalogue_version WHERE catalogue_record_id=? AND superseded_at IS NULL',
    )
    .get(catalogue.record_id) as { n: number }
  const n = maxN + 1
  if (prior) {
    d.query(
      "UPDATE step_catalogue_version SET status='retired',retired_at=? WHERE catalogue_record_id=? AND status='production' AND superseded_at IS NULL",
    ).run(now, catalogue.record_id)
    seedCatalogueEvent(d, catalogue.record_id, prior.n, 'retire', reason, now)
  }
  d.query(
    `INSERT INTO step_catalogue_version (record_id,catalogue_record_id,n,status,definition,author,reason,created_at,promoted_at) VALUES (?,?,?,'production',?,?,?,?,?)`,
  ).run(
    newRecordId(),
    catalogue.record_id,
    n,
    definition,
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
    now,
  )
  seedCatalogueEvent(d, catalogue.record_id, n, 'set', reason, now)
  seedCatalogueEvent(d, catalogue.record_id, n, 'promote', reason, now)
}

function requireValidSeedCatalogue(definition: unknown): void {
  const errors = validateStepCatalogue(definition)
  if (errors.length)
    throw new Error(
      `invalid seeded step catalogue:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    )
}

function storedCatalogueSeedRevision(d: Database, catalogueId: string): number {
  const events = d
    .query(
      'SELECT e.reason FROM step_catalogue_event e JOIN step_catalogue_version v ON v.record_id=e.catalogue_version_record_id WHERE v.catalogue_record_id=? AND v.superseded_at IS NULL AND e.author=?',
    )
    .all(catalogueId, BUILT_IN_WORKFLOW_AUTHOR) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

function operatorPromotedCatalogue(d: Database, catalogueId: string): boolean {
  return (
    d
      .query(
        "SELECT 1 FROM step_catalogue_event e JOIN step_catalogue_version v ON v.record_id=e.catalogue_version_record_id WHERE v.catalogue_record_id=? AND v.superseded_at IS NULL AND e.event='promote' AND e.author!=? LIMIT 1",
      )
      .get(catalogueId, BUILT_IN_WORKFLOW_AUTHOR) != null
  )
}

function storedSeedRevision(d: Database, workflowId: string): number {
  const events = d
    .query(
      'SELECT e.reason FROM workflow_event e JOIN workflow_version v ON v.record_id=e.workflow_version_record_id WHERE v.workflow_record_id=? AND v.superseded_at IS NULL AND e.author=?',
    )
    .all(workflowId, BUILT_IN_WORKFLOW_AUTHOR) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    if (reason === 'DEV-257 seed') return Math.max(highest, 1)
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

function operatorPromotedWorkflow(d: Database, workflowId: string): boolean {
  return (
    d
      .query(
        "SELECT 1 FROM workflow_event e JOIN workflow_version v ON v.record_id=e.workflow_version_record_id WHERE v.workflow_record_id=? AND v.superseded_at IS NULL AND e.event='promote' AND e.author!=? LIMIT 1",
      )
      .get(workflowId, BUILT_IN_WORKFLOW_AUTHOR) != null
  )
}

function seedWorkflow(d: Database, seed: (typeof seeds)[number], now: string): void {
  const reason = `seed r${seed.revision}`
  let workflow = d
    .query('SELECT record_id FROM workflow WHERE slug=? AND space_id IS NULL')
    .get(seed.slug) as {
    record_id: string
  } | null
  if (!workflow) {
    workflow = d
      .query(
        'INSERT INTO workflow (record_id, slug, created_at) VALUES (?, ?, ?) RETURNING record_id',
      )
      .get(newRecordId(), seed.slug, now) as { record_id: string }
    d.query(`INSERT INTO workflow_version
          (record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at)
          VALUES (?,?,1,'production',?,?,?,?,?)`).run(
      newRecordId(),
      workflow.record_id,
      seedDefinition(workflowDefinition(seed)),
      BUILT_IN_WORKFLOW_AUTHOR,
      reason,
      now,
      now,
    )
    seedWorkflowEvent(d, workflow.record_id, 1, 'set', reason, now)
    return
  }
  if (
    !seedMayPromote({
      seedRevision: seed.revision,
      storedSeedRevision: storedSeedRevision(d, workflow.record_id),
      operatorPromoted: operatorPromotedWorkflow(d, workflow.record_id),
    })
  )
    return
  // A workflow may have no production version (a draft never promoted); then there is nothing to retire.
  const prior = d
    .query(
      "SELECT n FROM workflow_version WHERE workflow_record_id=? AND status='production' AND superseded_at IS NULL",
    )
    .get(workflow.record_id) as { n: number } | null
  const { n: maxN } = d
    .query(
      'SELECT COALESCE(MAX(n),0) AS n FROM workflow_version WHERE workflow_record_id=? AND superseded_at IS NULL',
    )
    .get(workflow.record_id) as { n: number }
  const n = maxN + 1
  if (prior) {
    d.query(
      "UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_record_id=? AND status='production' AND superseded_at IS NULL",
    ).run(now, workflow.record_id)
    seedWorkflowEvent(d, workflow.record_id, prior.n, 'retire', reason, now)
  }
  d.query(`INSERT INTO workflow_version
        (record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at)
        VALUES (?,?,?,'production',?,?,?,?,?)`).run(
    newRecordId(),
    workflow.record_id,
    n,
    seedDefinition(workflowDefinition(seed)),
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
    now,
  )
  seedWorkflowEvent(d, workflow.record_id, n, 'set', reason, now)
  seedWorkflowEvent(d, workflow.record_id, n, 'promote', reason, now)
}

export function seedWorkflows(d: Database): void {
  // A bound store caches the hosted catalogue. Built-ins are authored only by
  // an unbound machine; seeding a bound store would recreate stale local rows.
  if (d.query('SELECT 1 FROM record_install_binding WHERE id=1').get()) return
  const now = nowIso()
  writeTransaction(() => {
    seedCatalogue(d, now)
    for (const seed of seeds) seedWorkflow(d, seed, now)
  }, d)
}
