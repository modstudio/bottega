import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const hooksDirectory = fileURLToPath(new URL('../.githooks', import.meta.url))
const binaryPath = `bin/${PLATFORM_SLUG}`
const mainCheckoutPrefix = '$main_checkout/'
const mainCheckoutAssignment = 'common_dir=$(git rev-parse --path-format=absolute --git-common-dir)'
const mainCheckoutFallback = `main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}`
const rule =
  "a tracked git hook runs the main checkout's binary, because a tree's binary can carry a journal ahead of the operator store"

test(`tracked git hooks run the main checkout ${PLATFORM_SLUG} binary`, () => {
  const failures = readdirSync(hooksDirectory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return []
    const file = `.githooks/${entry.name}`
    const lines = readFileSync(`${hooksDirectory}/${entry.name}`, 'utf8').split('\n')
    const occurrences = lines.flatMap((line, index) =>
      [...line.matchAll(new RegExp(binaryPath, 'g'))].map((match) => ({
        line: index + 1,
        valid:
          line.slice(match.index - mainCheckoutPrefix.length, match.index) === mainCheckoutPrefix,
      })),
    )
    if (occurrences.length === 0) return []
    const invalidOccurrences = occurrences
      .filter(({ valid }) => !valid)
      .map(({ line }) => `${file}:${line}: ${rule}`)
    if (
      !lines.some((line) => line.includes(mainCheckoutAssignment)) ||
      !lines.includes(mainCheckoutFallback)
    ) {
      invalidOccurrences.push(`${file}:1: ${rule}; assign main_checkout from --git-common-dir`)
    }
    return invalidOccurrences
  })

  expect(failures, failures.join('\n')).toEqual([])
})
