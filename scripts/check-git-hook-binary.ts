#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const binaryPath = `bin/${PLATFORM_SLUG}`
const mainCheckoutPrefix = '$main_checkout/'
const mainCheckoutAssignment = 'common_dir=$(git rev-parse --path-format=absolute --git-common-dir)'
const mainCheckoutFallback = `main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}`
const rule =
  "a tracked git hook runs the main checkout's binary, because a tree's binary can carry a journal ahead of the operator store"

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
  if (
    !lines.some((line) => line.includes(mainCheckoutAssignment)) ||
    !lines.includes(mainCheckoutFallback)
  ) {
    violations.push(`${file}:1: ${rule}; assign main_checkout from --git-common-dir`)
  }
  return violations
}

function main(): void {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const hooksDirectory = join(repositoryRoot, '.githooks')
  const violations = readdirSync(hooksDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const file = `.githooks/${entry.name}`
      return gitHookBinaryViolations(file, readFileSync(join(hooksDirectory, entry.name), 'utf8'))
    })

  for (const violation of violations) console.error(violation)
  if (violations.length > 0) process.exit(1)
}

if (import.meta.main) main()
