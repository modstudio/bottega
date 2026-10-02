// concern: setup-toolchain
/** Pure toolchain proposals from repository facts. Must not read files or know setup persistence. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { configDocumentSchema } from '../recipe/recipe-schema.ts'

export const INFERRED_RECIPE_PATH = `.${PLATFORM_SLUG}/worktree-recipe.jsonc`

export type DetectedPackageManager =
  | 'bun'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'composer'
  | 'bundler'
  | 'uv'
  | 'poetry'
  | 'pip'
  | 'go'
  | 'cargo'

export type ToolchainFacts = {
  packageManager: DetectedPackageManager | null
  lint: string | null
  typecheck: string | null
  test: string | null
  ci: boolean
  defaultConfigExists: boolean
  inferredRecipeExists: boolean
}

const INSTALL: Record<DetectedPackageManager, string[]> = {
  bun: ['bun', 'install', '--frozen-lockfile'],
  npm: ['npm', 'ci'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  yarn: ['yarn', 'install', '--immutable'],
  composer: ['composer', 'install'],
  bundler: ['bundle', 'install'],
  uv: ['uv', 'sync', '--frozen'],
  poetry: ['poetry', 'install', '--no-root'],
  pip: [],
  go: ['go', 'mod', 'download'],
  cargo: ['cargo', 'fetch'],
}

export function proposedGate(facts: ToolchainFacts): string | null {
  const commands = [facts.lint, facts.typecheck, facts.test].filter((command): command is string =>
    Boolean(command),
  )
  return commands.length ? commands.join(' && ') : null
}

function inferredRecipeDocument(facts: ToolchainFacts): unknown | null {
  const argv = facts.packageManager ? INSTALL[facts.packageManager] : []
  if (!argv.length) return null
  const document = {
    worktree: {
      create: [{ name: 'install dependencies', run: { command: argv[0]!, args: argv.slice(1) } }],
    },
  }
  configDocumentSchema.parse(document)
  return document
}

export function inferredRecipeContent(facts: ToolchainFacts): string | null {
  const document = inferredRecipeDocument(facts)
  return document ? `${JSON.stringify(document, null, 2)}\n` : null
}
