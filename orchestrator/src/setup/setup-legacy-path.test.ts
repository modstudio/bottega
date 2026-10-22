import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applySetupActions } from './setup-apply.ts'
import type { SetupPlan } from './setup-engine.ts'
import { captureLegacyPathSymlinks } from './setup-legacy-path.ts'
import { planSetupActions, recommendedAnswers, setupActionLine } from './setup-planner.ts'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-legacy-path-'))
  temporary.push(root)
  return root
}

function checkout(root: string): string {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', PLATFORM_SLUG), '#!/bin/sh\n')
  return join(root, 'bin', PLATFORM_SLUG)
}

test('setup plan proposes removing a checkout-pointing symlink and leaves others alone', () => {
  const root = scratch()
  const tree = join(root, 'checkout')
  mkdirSync(tree)
  const bin = checkout(tree)
  const pathDir = join(root, 'path')
  mkdirSync(pathDir)
  const remove = join(pathDir, 'orch')
  const elsewhere = join(pathDir, 'hub')
  const foreignDir = join(root, 'foreign')
  mkdirSync(foreignDir)
  const foreign = join(foreignDir, 'tool')
  writeFileSync(foreign, 'other-tool')
  symlinkSync(bin, remove)
  symlinkSync(foreign, elsewhere)
  const captured = captureLegacyPathSymlinks([pathDir])
  expect(captured).toHaveLength(1)
  expect(captured[0]?.path).toBe(remove)
  expect(captured[0]?.name).toBe('orch')
  expect(captured[0]?.target).toBe(bin)

  const plan = {
    registrations: [],
    proposals: [],
    questions: [],
    legacyPathSymlinks: captured,
  } as unknown as SetupPlan
  const actions = planSetupActions(plan, recommendedAnswers(plan))
  expect(actions).toEqual([{ kind: 'remove-legacy-symlink', path: remove, target: bin }])
  expect(setupActionLine(actions[0]!)).toBe(`Remove leftover ${remove} symlink`)
})

test('setup apply removes a checkout-pointing symlink and refuses a file or foreign link', async () => {
  const root = scratch()
  const tree = join(root, 'checkout')
  mkdirSync(tree)
  const bin = checkout(tree)
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
  symlinkSync(bin, remove)
  symlinkSync(foreign, foreignLink)
  const service = { add: async () => {}, fillAbsent: async () => {} }

  const removed = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: remove, target: bin }],
    service,
  )
  expect(removed[0]?.status).toBe('applied')
  expect(existsSync(remove)).toBe(false)

  const refusedFile = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: file, target: file }],
    service,
  )
  expect(refusedFile[0]?.status).toBe('refused')
  expect(refusedFile[0]?.message).toContain('not a symbolic link')
  expect(existsSync(file)).toBe(true)

  const refusedForeign = await applySetupActions(
    [{ kind: 'remove-legacy-symlink', path: foreignLink, target: foreign }],
    service,
  )
  expect(refusedForeign[0]?.status).toBe('refused')
  expect(refusedForeign[0]?.message).toContain('does not point into a')
  expect(existsSync(foreignLink)).toBe(true)
})
