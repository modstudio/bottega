import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DIST_MANIFEST } from '../../../shared/install-root.ts'
import {
  applySetupActions as applySetupActionsWithService,
  type SetupProjectService,
} from './setup-apply.ts'
import type { SetupPlan } from './setup-engine.ts'
import { captureLegacyPathSymlinks, pathDirectories } from './setup-legacy-path.ts'
import {
  planSetupActions,
  recommendedAnswers,
  type SetupAction,
  setupActionLine,
} from './setup-planner.ts'

const applySetupActions = (actions: SetupAction[], service: SetupProjectService) =>
  applySetupActionsWithService(actions, service, { migrateEnvironment: async () => null })

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-legacy-path-'))
  temporary.push(root)
  return root
}

function writeCheckoutBinary(root: string, name: 'orch' | 'hub'): string {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
  mkdirSync(join(root, 'bin'), { recursive: true })
  const binary = join(root, 'bin', name)
  writeFileSync(binary, '#!/bin/sh\n')
  return binary
}

function writeDistributionBinary(root: string, name: 'orch' | 'hub'): string {
  writeFileSync(join(root, DIST_MANIFEST), '{}')
  mkdirSync(join(root, 'bin'), { recursive: true })
  const binary = join(root, 'bin', name)
  writeFileSync(binary, '#!/bin/sh\n')
  return binary
}

test('a checkout leftover command symlink is captured and a docs link is not', () => {
  const root = scratch()
  const tree = join(root, 'checkout')
  mkdirSync(tree)
  const orch = writeCheckoutBinary(tree, 'orch')
  mkdirSync(join(tree, 'docs'))
  const notes = join(tree, 'docs', 'x.md')
  writeFileSync(notes, 'notes')
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const capturedLink = join(pathDir, 'orch')
  const docsLink = join(pathDir, 'hub')
  symlinkSync(orch, capturedLink)
  symlinkSync(notes, docsLink)
  expect(captureLegacyPathSymlinks([pathDir])).toEqual([{ path: capturedLink, target: orch }])
})

test('a distribution leftover command symlink is captured', () => {
  const root = scratch()
  const dist = join(root, 'dist')
  mkdirSync(dist)
  const hub = writeDistributionBinary(dist, 'hub')
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const capturedLink = join(pathDir, 'hub')
  symlinkSync(hub, capturedLink)
  expect(captureLegacyPathSymlinks([pathDir])).toEqual([{ path: capturedLink, target: hub }])
})

test('a relative PATH entry is skipped', () => {
  const absolute = join(scratch(), 'abs')
  expect(pathDirectories(`relative-bin:${absolute}:./bin`)).toEqual([absolute])
  expect(captureLegacyPathSymlinks(['relative-bin', './bin'])).toEqual([])
})

test('an installer leftover pointing at the sibling executable is captured and a foreign one is not', () => {
  const root = scratch()
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const sibling = join(pathDir, PLATFORM_SLUG)
  writeFileSync(sibling, '#!/bin/sh\n')
  const bare = join(pathDir, 'orch')
  const absolute = join(pathDir, 'hub')
  symlinkSync(PLATFORM_SLUG, bare)
  symlinkSync(sibling, absolute)
  const foreignDir = join(root, 'elsewhere')
  mkdirSync(foreignDir)
  const foreignExecutable = join(foreignDir, PLATFORM_SLUG)
  writeFileSync(foreignExecutable, '#!/bin/sh\n')
  const foreignNamed = join(root, 'named')
  mkdirSync(foreignNamed)
  symlinkSync(foreignExecutable, join(foreignNamed, 'orch'))
  expect(captureLegacyPathSymlinks([pathDir, foreignNamed])).toEqual([
    { path: bare, target: sibling },
    { path: absolute, target: sibling },
  ])
})

test('setup plan proposes removing a checkout-pointing symlink and leaves others alone', () => {
  const root = scratch()
  const tree = join(root, 'checkout')
  mkdirSync(tree)
  const orch = writeCheckoutBinary(tree, 'orch')
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const remove = join(pathDir, 'orch')
  const elsewhere = join(pathDir, 'hub')
  const foreignDir = join(root, 'foreign')
  mkdirSync(foreignDir)
  const foreign = join(foreignDir, 'tool')
  writeFileSync(foreign, 'other-tool')
  symlinkSync(orch, remove)
  symlinkSync(foreign, elsewhere)
  const captured = captureLegacyPathSymlinks([pathDir])
  expect(captured).toEqual([{ path: remove, target: orch }])

  const plan = {
    registrations: [],
    proposals: [],
    questions: [],
    legacyPathSymlinks: captured,
  } as unknown as SetupPlan
  const actions = planSetupActions(plan, recommendedAnswers(plan))
  expect(actions).toEqual([
    { kind: 'migrate-environment' },
    { kind: 'remove-legacy-symlink', path: remove, target: orch },
  ])
  expect(setupActionLine(actions[1]!)).toBe(`Remove leftover ${remove} symlink`)
})

test('setup apply removes a checkout-pointing symlink and refuses a file or foreign link', async () => {
  const root = scratch()
  const tree = join(root, 'checkout')
  mkdirSync(tree)
  const orch = writeCheckoutBinary(tree, 'orch')
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const remove = join(pathDir, 'orch')
  const file = join(pathDir, 'hub')
  const foreignLink = join(pathDir, 'other')
  const foreignDir = join(root, 'foreign')
  mkdirSync(foreignDir)
  const foreign = join(foreignDir, 'tool')
  writeFileSync(foreign, 'other-tool')
  writeFileSync(file, 'regular file')
  symlinkSync(orch, remove)
  symlinkSync(foreign, foreignLink)
  const service = { add: async () => {}, fillAbsent: async () => {} }

  const removed = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: remove, target: orch }],
    service,
  )
  expect(removed[0]?.status).toBe('applied')
  expect(existsSync(remove)).toBe(false)

  const refusedFile = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: file, target: file }],
    service,
  )
  expect(refusedFile[0]?.status).toBe('refused')
  expect(refusedFile[0]?.message).toContain('not a removable leftover PATH symlink')
  expect(refusedFile[0]?.message).toContain(
    `leave it or remove it by hand if you own it, then re-run ${PLATFORM_SLUG} machine setup plan`,
  )
  expect(existsSync(file)).toBe(true)

  const refusedForeign = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: foreignLink, target: foreign }],
    service,
  )
  expect(refusedForeign[0]?.status).toBe('refused')
  expect(refusedForeign[0]?.message).toContain('not a removable leftover PATH symlink')
  expect(refusedForeign[0]?.message).toContain(
    `leave it or remove it by hand if you own it, then re-run ${PLATFORM_SLUG} machine setup plan`,
  )
  expect(existsSync(foreignLink)).toBe(true)
})

test('apply refuses a link retargeted between plan and apply', async () => {
  const root = scratch()
  const tree = join(root, 'checkout')
  mkdirSync(tree)
  const orch = writeCheckoutBinary(tree, 'orch')
  const other = join(root, 'other')
  mkdirSync(other)
  const otherOrch = writeCheckoutBinary(other, 'orch')
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const link = join(pathDir, 'orch')
  symlinkSync(orch, link)
  const captured = captureLegacyPathSymlinks([pathDir])
  expect(captured).toEqual([{ path: link, target: orch }])
  rmSync(link)
  symlinkSync(otherOrch, link)
  const refused = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: link, target: orch }],
    { add: async () => {}, fillAbsent: async () => {} },
  )
  expect(refused[0]?.status).toBe('refused')
  expect(refused[0]?.message).toContain(`it now points at ${otherOrch}`)
  expect(refused[0]?.message).toContain(
    `re-run ${PLATFORM_SLUG} machine setup plan and apply the new plan`,
  )
  expect(existsSync(link)).toBe(true)
})
