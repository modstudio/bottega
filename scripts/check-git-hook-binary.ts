#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_ENV_NAMES, PLATFORM_SLUG } from '../shared/brand.ts'

const binaryPath = `bin/${PLATFORM_SLUG}`
const mainCheckoutVariable = 'main_checkout'
const mainCheckoutPrefix = `$${mainCheckoutVariable}/`
const commonDirectoryAssignment = ['common_dir=$(git', '--path-format=absolute --git-common-dir']
const mainCheckoutFallback = `${mainCheckoutVariable}=\${${FROZEN_ENV_NAMES.mainCheckout}:-$(dirname "$common_dir")}`
const rule =
  "a hook that runs the binary names the main checkout's copy, because a tree's binary can carry a journal ahead of the operator store"

function lineIncludesEvery(line: string, fragments: string[]): boolean {
  return fragments.every((fragment) => line.includes(fragment))
}

/** Violations of the tracked-hook main-checkout binary rule in one hook. */
export function gitHookBinaryViolations(file: string, text: string): string[] {
  const lines = text.split('\n')
  const occurrences = lines.flatMap((line, index) =>
    [...line.matchAll(new RegExp(binaryPath, 'g'))].map((match) => ({
      line: index + 1,
      valid:
        line.slice(match.index - mainCheckoutPrefix.length, match.index) === mainCheckoutPrefix,
    })),
  )
  if (occurrences.length === 0) return []

  const violations = occurrences
    .filter(({ valid }) => !valid)
    .map(({ line }) => `${file}:${line}: ${rule}`)
  const requiredAssignments = [commonDirectoryAssignment, [mainCheckoutFallback]]
  if (
    requiredAssignments.some(
      (fragments) => !lines.some((line) => lineIncludesEvery(line, fragments)),
    )
  ) {
    violations.push(`${file}:1: ${rule}; assign ${mainCheckoutVariable} from --git-common-dir`)
  }
  return violations
}

function main(): void {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const hooksDirectory = join(repositoryRoot, '.githooks')
  const orchestratorHooksDirectory = join(repositoryRoot, 'orchestrator', 'hooks')
  // Python hooks are rendered into harness settings by the main checkout's absolute path,
  // so their file-relative binary is the main checkout's by construction.
  const hookFiles = readdirSync(hooksDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `.githooks/${entry.name}`)
    .concat(
      readdirSync(orchestratorHooksDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
        .map((entry) => `orchestrator/hooks/${entry.name}`),
    )
  const violations = hookFiles.flatMap((file) =>
    gitHookBinaryViolations(file, readFileSync(join(repositoryRoot, file), 'utf8')),
  )

  for (const violation of violations) console.error(violation)
  if (violations.length > 0) process.exit(1)
}

if (import.meta.main) main()
