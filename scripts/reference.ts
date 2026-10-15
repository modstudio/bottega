#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, ROUTES } from '../cli/routes.ts'
import { program as hubProgram } from '../hub/src/cli-program.ts'
import { program as orchProgram } from '../orchestrator/src/cli/program.ts'
import { documentationInventory } from './command-descriptions.ts'
import { REGENERATE_COMMAND, renderReferencePages } from './command-reference.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const REFERENCE_DIRECTORY = 'docs/reference'
const referenceDirectory = join(root, REFERENCE_DIRECTORY)

function expectedPages() {
  return renderReferencePages(
    documentationInventory(GROUPS, ROUTES, { orch: orchProgram, hub: hubProgram }),
  )
}

function trackedMarkdown(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
}

function writePages() {
  mkdirSync(referenceDirectory, { recursive: true })
  const pages = expectedPages()
  const expected = new Set(pages.map((page) => page.file))
  for (const page of pages) writeFileSync(join(referenceDirectory, page.file), page.content)
  for (const extra of trackedMarkdown(referenceDirectory)) {
    if (!expected.has(extra)) unlinkSync(join(referenceDirectory, extra))
  }
  console.log(`wrote ${pages.length} pages to ${REFERENCE_DIRECTORY}`)
}

function checkPages(): boolean {
  const pages = expectedPages()
  const expected = new Map(pages.map((page) => [page.file, page.content]))
  const actual = new Set(trackedMarkdown(referenceDirectory))
  const failures: string[] = []
  for (const [file, content] of expected) {
    const path = join(referenceDirectory, file)
    if (!existsSync(path)) {
      failures.push(`${REFERENCE_DIRECTORY}/${file}: missing`)
      continue
    }
    if (readFileSync(path, 'utf8') !== content) {
      failures.push(`${REFERENCE_DIRECTORY}/${file}: differs`)
    }
  }
  for (const file of actual) {
    if (!expected.has(file)) failures.push(`${REFERENCE_DIRECTORY}/${file}: extra`)
  }
  if (failures.length === 0) {
    console.log(`command reference: ${pages.length} pages match`)
    return true
  }
  console.error('command reference check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error(`regenerate with: ${REGENERATE_COMMAND}`)
  return false
}

if (import.meta.main) {
  try {
    const cliArguments = Bun.argv.slice(2)
    if (cliArguments.length === 1 && cliArguments[0] === '--write') writePages()
    else if (cliArguments.length === 0) {
      if (!checkPages()) process.exit(1)
    } else throw new Error(`usage: bun scripts/reference.ts [--write]`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
