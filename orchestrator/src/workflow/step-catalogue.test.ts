import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { resolveTrackerAgentActions, TRACKER_PROTOCOLS } from '../../../shared/trackers.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  compatibleCatalogueStep,
  productionStepCatalogue,
  promoteStepCatalogue,
  showStepCatalogue,
  validateStepCatalogue,
} from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'

const step = {
  slug: 'design',
  title: 'Design',
  body: 'Design it.',
  floor: ['ruling'],
  job: null,
  autonomy: 'ask',
  needs: [],
}

test('workflow step tracker actions exist in every tracker protocol', () => {
  const stepsFolder = resolve(import.meta.dir, '../../../.agents/workflow-steps')
  const missing: string[] = []

  for (const file of readdirSync(stepsFolder)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    const body = readFileSync(join(stepsFolder, file), 'utf8')
    const actions = new Set(
      [...body.matchAll(/\{\{tracker\.actions\.([a-z]+)\}\}/g)].map((match) => match[1]!),
    )
    for (const action of actions) {
      for (const protocol of TRACKER_PROTOCOLS) {
        if (!Object.hasOwn(resolveTrackerAgentActions(protocol), action)) {
          missing.push(
            `step "${basename(file, '.md')}" names tracker action "${action}" missing from protocol "${protocol}"`,
          )
        }
      }
    }
  }

  expect(missing).toEqual([])
})

test('new catalogue versions require a stage and reject legacy proof names', () => {
  expect(validateStepCatalogue({ steps: [step] })).toContain(
    'step "design" has invalid or missing stage "undefined"',
  )
  expect(
    validateStepCatalogue({ steps: [{ ...step, stage: 'plan', floor: ['human-ruling'] }] }),
  ).toContain('step "design" has invalid floor kind "human-ruling"')
})

test('stored legacy steps normalize without revalidation', () => {
  expect(
    compatibleCatalogueStep({ ...step, autonomy: 'manual', floor: ['human-ruling'] } as never),
  ).toMatchObject({ autonomy: 'ask', floor: ['ruling'] })
})

test('operatorRuling requires a ruling floor', () => {
  expect(
    validateStepCatalogue({
      steps: [{ ...step, stage: 'ship', floor: ['tracker-transition'], operatorRuling: true }],
    }),
  ).toContain('step "design" operatorRuling requires a ruling floor')
  expect(
    validateStepCatalogue({ steps: [{ ...step, stage: 'ship', operatorRuling: true }] }),
  ).toEqual([])
  expect(
    validateStepCatalogue({
      steps: [
        {
          ...step,
          stage: 'ship',
          floor: ['{{shipTo.closeFloor}}'],
          operatorRuling: true,
        },
      ],
    }),
  ).toEqual([])
  expect(
    validateStepCatalogue({ steps: [{ ...step, stage: 'ship', floor: ['prefix {{floor}}'] }] }),
  ).toContain('step "design" has invalid floor kind "prefix {{floor}}"')
})

test('commandEvidence gate requires a non-deferrable command-exit floor', () => {
  expect(
    validateStepCatalogue({
      steps: [{ ...step, stage: 'ship', floor: ['command-exit'], commandEvidence: 'gate' }],
    }),
  ).toEqual([])
  expect(
    validateStepCatalogue({
      steps: [{ ...step, stage: 'ship', floor: ['ruling'], commandEvidence: 'gate' }],
    }),
  ).toContain('step "design" commandEvidence requires a command-exit floor')
  expect(
    validateStepCatalogue({
      steps: [
        {
          ...step,
          stage: 'ship',
          floor: ['command-exit'],
          deferrable: ['command-exit'],
          commandEvidence: 'gate',
        },
      ],
    }),
  ).toContain('step "design" cannot defer command-exit when commandEvidence is "gate"')
})

test('orch do dispatches require a prompt or file', () => {
  const definition = (body: string) => ({ steps: [{ ...step, stage: 'implement', body }] })

  expect(validateStepCatalogue(definition('Dispatch `orch do implement --key DEV-1`.'))).toContain(
    'step "design" dispatch "orch do implement --key DEV-1" must include --file or a double-quoted argument',
  )
  expect(
    validateStepCatalogue(definition('Dispatch `orch do implement --key "DEV-1"`.')),
  ).toContain(
    'step "design" dispatch "orch do implement --key "DEV-1"" must include --file or a double-quoted argument',
  )
  expect(
    validateStepCatalogue(definition('Dispatch `orch do implement --key DEV-1 --file`.')),
  ).toContain(
    'step "design" dispatch "orch do implement --key DEV-1 --file" must include --file or a double-quoted argument',
  )
  expect(
    validateStepCatalogue(
      definition('Dispatch `orch do implement --key DEV-1 "Implement the specified change."`.'),
    ),
  ).toEqual([])
  expect(
    validateStepCatalogue(
      definition('Dispatch `/checkout/bin/orch do implement --key DEV-1 --file specification.md`.'),
    ),
  ).toEqual([])
})

test('promoting a stored pre-validator draft revalidates before changing production', () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  const production = productionStepCatalogue(d)
  const invalid = {
    steps: production.definition.steps.map((item) =>
      item.slug === 'diagnose'
        ? { ...item, body: 'Dispatch `orch do diagnose --key {{key}}`.' }
        : item,
    ),
  }
  d.query(
    `INSERT INTO step_catalogue_version
      (catalogue_id,n,status,definition,author,reason,created_at)
      VALUES (?,2,'draft',?,'legacy','pre-validator draft','2026-01-01T00:00:00.000Z')`,
  ).run(production.owner_id, JSON.stringify(invalid))

  expect(() => promoteStepCatalogue(2, 'promote legacy', 'architect', d)).toThrow(
    'step "diagnose" dispatch "orch do diagnose --key {{key}}" must include --file or a double-quoted argument',
  )
  expect(productionStepCatalogue(d).n).toBe(production.n)
  expect(showStepCatalogue(2, d).status).toBe('draft')
})
