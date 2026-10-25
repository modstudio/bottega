import { expect, test } from 'bun:test'
import { cloneRepository } from '../../../shared/test-git-repository.ts'
import { gateStoreSource } from '../../scripts/branch-store.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { compilePack, compilePackFromGateFacts } from '../canon/canon.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { collectGateFacts, parseGateFacts } from './gate-facts.ts'

test('selects the existing path for every compatible store kind and refuses unavailable ahead facts', () => {
  expect(gateStoreSource('current', false)).toEqual({ kind: 'existing', storeKind: 'current' })
  expect(gateStoreSource('behind', false)).toEqual({ kind: 'existing', storeKind: 'behind' })
  expect(gateStoreSource('absent', false)).toEqual({ kind: 'existing', storeKind: 'absent' })
  expect(gateStoreSource('ahead', true)).toEqual({ kind: 'gate-facts' })
  expect(gateStoreSource('ahead', false)).toEqual({ kind: 'refuse' })
})

test('refuses a snapshot format newer than the branch understands', () => {
  expect(() =>
    parseGateFacts(
      JSON.stringify({ formatVersion: 2, migrationVersion: 1, projects: [], docs: [] }),
    ),
  ).toThrow('unknown gate-facts format version 2')
})

test('a serialized snapshot compiles the same pack as its store', async () => {
  const repository = cloneRepository(process.env, 'gate-facts-project-')
  upsertProject({
    recordId: crypto.randomUUID(),
    name: 'gate-facts-project',
    path: repository,
    settings: { trunk: 'main', checks: { spelling: true, commentHistory: true } },
  })
  await setDoc({
    scope: 'canon',
    subject: null,
    slug: '.agents/rules/global.md',
    title: 'Global',
    body: '---\ndescription: Global rule\nalways: true\n---\n\nGlobal body.\n',
  })
  await setDoc({
    scope: 'job',
    subject: 'understand',
    slug: 'injected',
    title: 'Injected',
    body: 'Injected body.',
  })
  await setDoc({
    scope: 'canon',
    subject: 'gate-facts-project',
    slug: '.agents/rules/project.md',
    title: 'Project',
    body: '---\ndescription: Project rule\nalways: true\n---\n\nProject body.\n',
  })
  await setDoc({
    scope: 'job',
    subject: 'understand',
    slug: 'on-demand',
    title: 'On demand',
    body: 'Demand body.',
    delivery: 'demand',
  })

  const facts = parseGateFacts(JSON.stringify(collectGateFacts(db())))
  expect(compilePackFromGateFacts({ job: 'understand', cwd: repository }, facts)).toEqual(
    compilePack({ job: 'understand', cwd: repository }),
  )
})
