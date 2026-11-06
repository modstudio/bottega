import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkoutPathsSame,
  evidenceCheckoutRefusal,
  realpathOrSpelled,
} from './checkout-identity.ts'

const project = '/projects/app'
const worktreeBase = `${project}/.claude/worktrees`

test.each([
  {
    name: 'worktree base resolved to the main checkout',
    cwd: worktreeBase,
    topLevel: project,
    refusal: 'worktree-area-resolved-outside',
  },
  {
    name: 'directory below the worktree base resolved to the main checkout',
    cwd: `${worktreeBase}/stranded/logs`,
    topLevel: project,
    refusal: 'worktree-area-resolved-outside',
  },
  {
    name: 'ordinary checkout subdirectory',
    cwd: `${project}/hub/web`,
    topLevel: project,
    refusal: null,
  },
  {
    name: 'linked worktree root',
    cwd: `${worktreeBase}/DEV-2150`,
    topLevel: `${worktreeBase}/DEV-2150`,
    refusal: null,
  },
  {
    name: 'linked worktree subdirectory',
    cwd: `${worktreeBase}/DEV-2150/hub/web`,
    topLevel: `${worktreeBase}/DEV-2150`,
    refusal: null,
  },
  {
    name: 'main checkout root',
    cwd: project,
    topLevel: project,
    refusal: null,
  },
])('$name', ({ cwd, topLevel, refusal }) => {
  expect(evidenceCheckoutRefusal({ cwd, topLevel, worktreeBase })).toBe(refusal)
})

test('realpath preserves the refusal across a case-insensitive worktree-base spelling', () => {
  const root = mkdtempSync(join(tmpdir(), 'checkout-identity-'))
  const base = join(root, 'Worktrees')
  const stranded = join(base, 'Stranded')
  mkdirSync(stranded, { recursive: true })
  try {
    const differentlyCasedBase = join(root, 'worktrees')
    if (checkoutPathsSame(base, differentlyCasedBase) !== true) return
    expect(
      evidenceCheckoutRefusal({
        cwd: realpathSync(stranded),
        topLevel: realpathSync(root),
        worktreeBase: realpathOrSpelled(differentlyCasedBase),
      }),
    ).toBe('worktree-area-resolved-outside')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
