import { expect, test } from 'bun:test'
import { compatibleCatalogueStep, validateStepCatalogue } from './step-catalogue.ts'

const step = {
  slug: 'design',
  title: 'Design',
  body: 'Design it.',
  floor: ['ruling'],
  job: null,
  autonomy: 'ask',
  needs: [],
}

test('new catalogue versions require a stage and reject legacy proof names', () => {
  expect(validateStepCatalogue({ steps: [step] })).toContain(
    'step "design" has invalid or missing stage "undefined"',
  )
  expect(
    validateStepCatalogue({ steps: [{ ...step, stage: 'plan', floor: ['human-ruling'] }] }),
  ).toContain('step "design" has invalid proof kind "human-ruling"')
})

test('stored legacy steps normalize without revalidation', () => {
  expect(
    compatibleCatalogueStep({ ...step, autonomy: 'manual', floor: ['human-ruling'] } as never),
  ).toMatchObject({ autonomy: 'ask', floor: ['ruling'] })
})

test('orch do dispatches require a prompt or file', () => {
  const definition = (body: string) => ({ steps: [{ ...step, stage: 'implement', body }] })

  expect(validateStepCatalogue(definition('Dispatch `orch do implement --key DEV-1`.'))).toContain(
    'step "design" dispatch "orch do implement --key DEV-1" must include --file or a double-quoted argument',
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
