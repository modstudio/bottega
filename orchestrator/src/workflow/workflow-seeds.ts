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

function seedCatalogue(d: Database, now: string): void {
  const seeded = catalogueDefinition(),
    seededDefinition = JSON.stringify(seeded),
    revision = 6,
    reason = `seed r${revision}`
  requireValidSeedCatalogue(seeded)
  let catalogue = d
    .query("SELECT id FROM step_catalogue WHERE slug='shared' AND space_id IS NULL")
    .get() as {
    id: number
  } | null
  if (!catalogue) {
    catalogue = d
      .query(
        "INSERT INTO step_catalogue (record_id,slug,created_at) VALUES (?,'shared',?) RETURNING id",
      )
      .get(newRecordId(), now) as { id: number }
    d.query(
      `INSERT INTO step_catalogue_version (record_id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at) VALUES (?,?,1,'production',?,?,?,?,?)`,
    ).run(newRecordId(), catalogue.id, seededDefinition, BUILT_IN_WORKFLOW_AUTHOR, reason, now, now)
    d.query(
      `INSERT INTO step_catalogue_event (record_id,catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,1,'set',?,?,NULL,?)`,
    ).run(newRecordId(), catalogue.id, BUILT_IN_WORKFLOW_AUTHOR, reason, now)
    return
  }
  if (
    !seedMayPromote({
      seedRevision: revision,
      storedSeedRevision: storedCatalogueSeedRevision(d, catalogue.id),
      operatorPromoted: operatorPromotedCatalogue(d, catalogue.id),
    })
  )
    return
  const prior = d
    .query(
      "SELECT n,definition FROM step_catalogue_version WHERE catalogue_id=? AND status='production'",
    )
    .get(catalogue.id) as { n: number; definition: string } | null
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
    .query('SELECT COALESCE(MAX(n),0) AS n FROM step_catalogue_version WHERE catalogue_id=?')
    .get(catalogue.id) as { n: number }
  const n = maxN + 1
  if (prior) {
    d.query(
      "UPDATE step_catalogue_version SET status='retired',retired_at=? WHERE catalogue_id=? AND status='production'",
    ).run(now, catalogue.id)
    d.query(
      `INSERT INTO step_catalogue_event (record_id,catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,?,'retire',?,?,NULL,?)`,
    ).run(newRecordId(), catalogue.id, prior.n, BUILT_IN_WORKFLOW_AUTHOR, reason, now)
  }
  d.query(
    `INSERT INTO step_catalogue_version (record_id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at) VALUES (?,?,?,'production',?,?,?,?,?)`,
  ).run(newRecordId(), catalogue.id, n, definition, BUILT_IN_WORKFLOW_AUTHOR, reason, now, now)
  d.query(
    `INSERT INTO step_catalogue_event (record_id,catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,?,'set',?,?,NULL,?)`,
  ).run(newRecordId(), catalogue.id, n, BUILT_IN_WORKFLOW_AUTHOR, reason, now)
  d.query(
    `INSERT INTO step_catalogue_event (record_id,catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,?,'promote',?,?,NULL,?)`,
  ).run(newRecordId(), catalogue.id, n, BUILT_IN_WORKFLOW_AUTHOR, reason, now)
}

function requireValidSeedCatalogue(definition: unknown): void {
  const errors = validateStepCatalogue(definition)
  if (errors.length)
    throw new Error(
      `invalid seeded step catalogue:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    )
}

function storedCatalogueSeedRevision(d: Database, catalogueId: number): number {
  const events = d
    .query('SELECT reason FROM step_catalogue_event WHERE catalogue_id=? AND author=?')
    .all(catalogueId, BUILT_IN_WORKFLOW_AUTHOR) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

function operatorPromotedCatalogue(d: Database, catalogueId: number): boolean {
  return (
    d
      .query(
        "SELECT 1 FROM step_catalogue_event WHERE catalogue_id=? AND event='promote' AND author!=? LIMIT 1",
      )
      .get(catalogueId, BUILT_IN_WORKFLOW_AUTHOR) != null
  )
}

function storedSeedRevision(d: Database, workflowId: number): number {
  const events = d
    .query('SELECT reason FROM workflow_event WHERE workflow_id=? AND author=?')
    .all(workflowId, BUILT_IN_WORKFLOW_AUTHOR) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    if (reason === 'DEV-257 seed') return Math.max(highest, 1)
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

function operatorPromotedWorkflow(d: Database, workflowId: number): boolean {
  return (
    d
      .query(
        "SELECT 1 FROM workflow_event WHERE workflow_id=? AND event='promote' AND author!=? LIMIT 1",
      )
      .get(workflowId, BUILT_IN_WORKFLOW_AUTHOR) != null
  )
}

function seedWorkflow(d: Database, seed: (typeof seeds)[number], now: string): void {
  const reason = `seed r${seed.revision}`
  let workflow = d
    .query('SELECT id FROM workflow WHERE slug=? AND space_id IS NULL')
    .get(seed.slug) as {
    id: number
  } | null
  if (!workflow) {
    workflow = d
      .query('INSERT INTO workflow (record_id, slug, created_at) VALUES (?, ?, ?) RETURNING id')
      .get(newRecordId(), seed.slug, now) as { id: number }
    d.query(`INSERT INTO workflow_version
          (record_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at)
          VALUES (?,?,1,'production',?,?,?,?,?)`).run(
      newRecordId(),
      workflow.id,
      seedDefinition(workflowDefinition(seed)),
      BUILT_IN_WORKFLOW_AUTHOR,
      reason,
      now,
      now,
    )
    d.query(`INSERT INTO workflow_event
          (record_id,workflow_id,version_n,event,author,reason,session_id,at)
          VALUES (?,?,1,'set',?,?,NULL,?)`).run(
      newRecordId(),
      workflow.id,
      BUILT_IN_WORKFLOW_AUTHOR,
      reason,
      now,
    )
    return
  }
  if (
    !seedMayPromote({
      seedRevision: seed.revision,
      storedSeedRevision: storedSeedRevision(d, workflow.id),
      operatorPromoted: operatorPromotedWorkflow(d, workflow.id),
    })
  )
    return
  // A workflow may have no production version (a draft never promoted); then there is nothing to retire.
  const prior = d
    .query("SELECT n FROM workflow_version WHERE workflow_id=? AND status='production'")
    .get(workflow.id) as { n: number } | null
  const { n: maxN } = d
    .query('SELECT COALESCE(MAX(n),0) AS n FROM workflow_version WHERE workflow_id=?')
    .get(workflow.id) as { n: number }
  const n = maxN + 1
  if (prior) {
    d.query(
      "UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_id=? AND status='production'",
    ).run(now, workflow.id)
    d.query(`INSERT INTO workflow_event
          (record_id,workflow_id,version_n,event,author,reason,session_id,at)
          VALUES (?,?,?,'retire',?,?,NULL,?)`).run(
      newRecordId(),
      workflow.id,
      prior.n,
      BUILT_IN_WORKFLOW_AUTHOR,
      reason,
      now,
    )
  }
  d.query(`INSERT INTO workflow_version
        (record_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at)
        VALUES (?,?,?,'production',?,?,?,?,?)`).run(
    newRecordId(),
    workflow.id,
    n,
    seedDefinition(workflowDefinition(seed)),
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
    now,
  )
  d.query(`INSERT INTO workflow_event
        (record_id,workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,?,?,'set',?,?,NULL,?)`).run(
    newRecordId(),
    workflow.id,
    n,
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
  )
  d.query(`INSERT INTO workflow_event
        (record_id,workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,?,?,'promote',?,?,NULL,?)`).run(
    newRecordId(),
    workflow.id,
    n,
    BUILT_IN_WORKFLOW_AUTHOR,
    reason,
    now,
  )
}

export function seedWorkflows(d: Database): void {
  const now = nowIso()
  writeTransaction(() => {
    seedCatalogue(d, now)
    for (const seed of seeds) seedWorkflow(d, seed, now)
  }, d)
}
