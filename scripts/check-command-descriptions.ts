#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GROUPS, ROUTES } from '../cli/routes.ts'
import { program as hubProgram } from '../hub/src/cli-program.ts'
import { program as orchProgram } from '../orchestrator/src/cli/program.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  descriptionBaselineFailures,
  descriptionFindings,
  documentationUnits,
} from './command-descriptions.ts'

const BASELINE_PATH = fileURLToPath(new URL('./quality/command-descriptions.json', import.meta.url))
const REGENERATE_COMMAND = 'bun scripts/check-command-descriptions.ts --write-baseline'

function currentFindings() {
  return descriptionFindings(
    documentationUnits(GROUPS, ROUTES, { orch: orchProgram, hub: hubProgram }),
  )
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
  const findings = currentFindings()
  const failures = descriptionBaselineFailures(findings, readBaseline())
  if (failures.length) {
    console.error('command description check failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error(`regenerate the baseline with: ${REGENERATE_COMMAND}`)
    return false
  }
  console.log(`command descriptions: ${findings.length} baseline findings remain`)
  return true
}

if (import.meta.main) {
  try {
    const cliArguments = Bun.argv.slice(2)
    if (cliArguments.length === 1 && cliArguments[0] === '--write-baseline') writeBaseline()
    else if (cliArguments.length === 0) {
      if (!checkBaseline()) process.exit(1)
    } else
      throw new Error(
        `usage: ${REGENERATE_COMMAND.replace(' --write-baseline', ' [--write-baseline]')}`,
      )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
