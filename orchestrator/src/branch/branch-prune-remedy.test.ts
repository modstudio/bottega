import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { operatorTaskBranchCommand } from './branch-prune-remedy.ts'

test('a superseded task branch operator line uses the disposal remedy', () => {
  expect(operatorTaskBranchCommand('superseded', 'example', 'DEV-2550-old', 'DEV-2550')).toBe(
    `${PLATFORM_SLUG} tree branch dispose example:DEV-2550-old --reason superseded --note "superseded by <branch>"`,
  )
})
