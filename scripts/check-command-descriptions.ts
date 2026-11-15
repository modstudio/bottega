#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, HIDDEN_OWNER_COMMANDS, ROUTES } from '../cli/routes.ts'
import { program as hubProgram } from '../hub/src/cli-program.ts'
import { program as orchProgram } from '../orchestrator/src/cli/program.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  bareCommandArgumentDeclarations,
  descriptionBaselineFailures,
  descriptionFindings,
  documentationInventory,
} from './command-descriptions.ts'

const BASELINE_PATH = fileURLToPath(new URL('./quality/command-descriptions.json', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGENERATE_COMMAND = 'bun scripts/check-command-descriptions.ts --write-baseline'

function currentInventory() {
  const programs = { orch: orchProgram, hub: hubProgram } as const
  for (const [owner, names] of Object.entries(HIDDEN_OWNER_COMMANDS) as [
    keyof typeof programs,
    readonly string[],
  ][]) {
    const registered = new Set(programs[owner].commands.map((command) => command.name()))
    for (const name of names)
      if (!registered.has(name))
        throw new Error(`${owner} hidden command is not registered: ${name}`)
  }
  return documentationInventory(GROUPS, ROUTES, programs)
}

function currentFindings() {
  return descriptionFindings(currentInventory().units)
}

function printNotWalked(notWalked: readonly string[]) {
  for (const spelling of notWalked) {
    console.log(`not walked: converted by DEV-1332: ${spelling}`)
  }
}

function readBaseline(): string[] {
  const value: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${BASELINE_PATH}: expected a JSON array of command spellings`)
  }
  return value
}

function writeBaseline() {
  const spellings = currentFindings().map((finding) =>
    finding.spelling.slice(`${PLATFORM_SLUG} `.length),
  )
  writeFileSync(BASELINE_PATH, `${JSON.stringify(spellings, null, 2)}\n`)
  console.log(`wrote ${spellings.length} findings to ${BASELINE_PATH}`)
}

function checkBaseline(): boolean {
  const inventory = currentInventory()
  const findings = descriptionFindings(inventory.units)
  const failures = descriptionBaselineFailures(findings, readBaseline())
  if (failures.length) {
    console.error('command description check failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error(`regenerate the baseline with: ${REGENERATE_COMMAND}`)
    return false
  }
  console.log(`command descriptions: ${findings.length} baseline findings remain`)
  printNotWalked(inventory.notWalked)
  return true
}

function commandDeclarationFailures(): string[] {
  const glob = new Bun.Glob('{orchestrator/src,hub/src}/**/*.ts')
  const failures: string[] = []
  for (const path of glob.scanSync({ cwd: ROOT, absolute: true })) {
    if (path.endsWith('.test.ts')) continue
    const source = readFileSync(path, 'utf8')
    if (!source.includes('.command(')) continue
    for (const declaration of bareCommandArgumentDeclarations(source)) {
      failures.push(
        `${relative(ROOT, path)}: .command(${JSON.stringify(declaration)}) has a bare argument token; make each literal word a nested command or bracket the argument`,
      )
    }
  }
  return failures.sort()
}

function checkCommandDeclarations(): boolean {
  const failures = commandDeclarationFailures()
  if (failures.length === 0) return true
  console.error('command declaration check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  return false
}

if (import.meta.main) {
  try {
    const cliArguments = Bun.argv.slice(2)
    if (cliArguments.length === 1 && cliArguments[0] === '--write-baseline') writeBaseline()
    else if (cliArguments.length === 0) {
      if (![checkBaseline(), checkCommandDeclarations()].every(Boolean)) process.exit(1)
    } else
      throw new Error(
        `usage: ${REGENERATE_COMMAND.replace(' --write-baseline', ' [--write-baseline]')}`,
      )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
