import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { declaredProjectSpace } from './declared-project-space.ts'

test('returns a declared project space', () => {
  expect(declaredProjectSpace({ name: 'fixture', settings: { space: 'team' } })).toEqual({
    space: 'team',
  })
})

test('returns a trimmed declared project space', () => {
  expect(declaredProjectSpace({ name: 'fixture', settings: { space: '  team  ' } })).toEqual({
    space: 'team',
  })
})

test('refuses a missing project space with the register remedy', () => {
  expect(declaredProjectSpace({ name: 'fixture', settings: {} })).toEqual({
    refused: `project fixture has no declared record space; run \`${PLATFORM_SLUG} project set fixture --space <slug>\``,
  })
})
