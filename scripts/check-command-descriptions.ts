#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { GROUPS, HIDDEN_OWNER_COMMANDS, ROUTES } from '../cli/routes.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  type CommandPrograms,
  descriptionBaselineFailures,
  descriptionFindings,
  documentationInventory,
} from './command-descriptions.ts'

const BASELINE_PATH = fileURLToPath(new URL('./quality/command-descriptions.json', import.meta.url))
const REGENERATE_COMMAND = 'bun scripts/check-command-descriptions.ts --write-baseline'

export type CommandRegistration = {
  declaration: string
  parentPath: string
}

function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current; current = current.parent) {
    if (current.name()) names.push(current.name())
  }
  return names.reverse().join(' ')
}

export async function recordCommandRegistrations<T>(
  build: () => T | Promise<T>,
): Promise<{ registrations: CommandRegistration[]; value: T }> {
  const registrations: CommandRegistration[] = []
  const original = Command.prototype.command
  Command.prototype.command = function (this: Command, declaration: string, ...rest: unknown[]) {
    registrations.push({ declaration, parentPath: commandPath(this) })
    return (original as (...values: unknown[]) => Command).apply(this, [declaration, ...rest])
  } as typeof Command.prototype.command
  try {
    return { registrations, value: await build() }
  } finally {
    Command.prototype.command = original
  }
}

const commandArgumentToken = /^(?:<[^<>]+>|\[[^[\]]+\])$/

export function commandRegistrationFailures(
  registrations: readonly CommandRegistration[],
): string[] {
  if (registrations.length === 0) {
    return [
      'command registration check recorded zero commands; the program builders were not inspected',
    ]
  }
  return registrations
    .flatMap(({ declaration, parentPath }) => {
      const tokens = declaration.trim().split(/\s+/)
      if (
        tokens.length === 1 ||
        tokens.slice(1).every((token) => commandArgumentToken.test(token))
      ) {
        return []
      }
      const location = parentPath ? `${parentPath}: ` : ''
      return [
        `${location}.command(${JSON.stringify(declaration)}) has a bare argument token; make each literal word a nested command or bracket the argument`,
      ]
    })
    .sort()
}

export async function buildCommandPrograms(): Promise<{
  programs: CommandPrograms
  registrations: CommandRegistration[]
}> {
  const { registrations, value } = await recordCommandRegistrations(async () => {
    const [{ program: orch }, { program: hub }] = await Promise.all([
      import('../orchestrator/src/cli/program.ts'),
      import('../hub/src/cli-program.ts'),
    ])
    return { orch, hub } as const
  })
  return { programs: value, registrations }
}

function currentInventory(programs: CommandPrograms) {
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

function currentFindings(programs: CommandPrograms) {
  return descriptionFindings(currentInventory(programs).units)
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

function writeBaseline(programs: CommandPrograms) {
  const spellings = currentFindings(programs).map((finding) =>
    finding.spelling.slice(`${PLATFORM_SLUG} `.length),
  )
  writeFileSync(BASELINE_PATH, `${JSON.stringify(spellings, null, 2)}\n`)
  console.log(`wrote ${spellings.length} findings to ${BASELINE_PATH}`)
}

function checkBaseline(programs: CommandPrograms, registrationCount: number): boolean {
  const inventory = currentInventory(programs)
  const findings = descriptionFindings(inventory.units)
  const failures = descriptionBaselineFailures(findings, readBaseline())
  if (failures.length) {
    console.error('command description check failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error(`regenerate the baseline with: ${REGENERATE_COMMAND}`)
    return false
  }
  console.log(
    `command descriptions: ${findings.length} baseline findings remain; ${registrationCount} command registrations inspected`,
  )
  printNotWalked(inventory.notWalked)
  return true
}

function checkCommandRegistrations(registrations: readonly CommandRegistration[]): boolean {
  const failures = commandRegistrationFailures(registrations)
  if (failures.length === 0) return true
  console.error('command declaration check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  return false
}

if (import.meta.main) {
  try {
    const { programs, registrations } = await buildCommandPrograms()
    const cliArguments = Bun.argv.slice(2)
    if (cliArguments.length === 1 && cliArguments[0] === '--write-baseline') writeBaseline(programs)
    else if (cliArguments.length === 0) {
      if (
        ![
          checkBaseline(programs, registrations.length),
          checkCommandRegistrations(registrations),
        ].every(Boolean)
      )
        process.exit(1)
    } else
      throw new Error(
        `usage: ${REGENERATE_COMMAND.replace(' --write-baseline', ' [--write-baseline]')}`,
      )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
