import { expect, test } from 'bun:test'
import type { Command } from 'commander'
import { createHubProgram, program as hubProgram, run as runHub } from '../hub/src/cli-program.ts'
import { program as orchProgram, run as runOrchestrator } from '../orchestrator/src/cli/program.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { type BinaryEntries, dispatchBinary } from './dispatch.ts'
import { ROUTES, resolveRoute } from './routes.ts'

function commandExists(program: Command, path: readonly string[]): boolean {
  let current = program
  for (const name of path) {
    const next = current.commands.find((candidate) => candidate.name() === name)
    if (!next) return false
    current = next
  }
  return true
}

function captureCommandOutput(command: Command, lines: string[]): void {
  command.configureOutput({
    writeOut: (value) => lines.push(value),
    writeErr: (value) => lines.push(value),
  })
  for (const child of command.commands) captureCommandOutput(child, lines)
}

test('wrapper help prints public orchestrator, hub, and translated usage paths', async () => {
  const lines: string[] = []
  const entries: BinaryEntries = {
    orch: async (argv, invocation) => {
      captureCommandOutput(orchProgram, lines)
      return runOrchestrator(argv, invocation)
    },
    hub: async (argv, invocation) => {
      const program = createHubProgram()
      captureCommandOutput(program, lines)
      return runHub(program, argv, invocation)
    },
    orchOutbox: async () => [],
    hubOutbox: async () => [],
    hubOutboxSummaryLines: async () => [],
    runExec: async () => 0,
    askProxy: async () => 0,
    retrievalSearch: async () => {},
    checkAttribution: async () => 0,
    schemaCheck: async () => 0,
  }
  for (const argv of [
    ['workflow', 'attach', '--help'],
    ['task', 'new', '--help'],
    ['run', 'start', '--help'],
  ]) {
    lines.length = 0
    expect(await dispatchBinary(argv, entries, () => '')).toBe(0)
    expect(lines.join('')).toContain(`Usage: ${PLATFORM_SLUG} ${argv.slice(0, -1).join(' ')}`)
  }
})

test('every route resolves to an existing owner command', () => {
  for (const route of ROUTES) {
    const targets =
      route.composite ??
      (route.owner === 'orch' || route.owner === 'hub'
        ? [{ owner: route.owner, argv: route.argv ?? [] }]
        : [])
    for (const target of targets) {
      const program = target.owner === 'orch' ? orchProgram : hubProgram
      const prefix = target.argv[0] === 'init-db' ? [] : target.argv.slice(0, 2)
      expect(
        commandExists(program, prefix),
        `${route.command.join(' ')} -> ${target.owner} ${target.argv.join(' ')}`,
      ).toBeTrue()
    }
  }
})

function commandAt(program: Command, path: readonly string[]): Command {
  let current = program
  for (const name of path)
    current = current.commands.find((candidate) => candidate.name() === name)!
  return current
}

test('each composite part declares exactly the options its owner command accepts', () => {
  // --watch is refused on purpose: a composite must not start a command that never returns.
  const refused = new Set(['--help', '--watch'])
  for (const route of ROUTES) {
    for (const part of route.composite ?? []) {
      const program = part.owner === 'orch' ? orchProgram : hubProgram
      const accepted = commandAt(program, part.argv)
        .options.map((option) => option.long)
        .filter((name): name is string => !!name && !refused.has(name))
        .sort()
      expect(
        Object.keys(part.options ?? {}).sort(),
        `${route.command.join(' ')}: ${part.label}`,
      ).toEqual(accepted)
    }
  }
})

test('in-process note filing reaches the command that accepts its options', () => {
  // fileNote sends this through the front door; a route to a command without these
  // options fails every worker, ruling and canon note with an unknown-option error.
  const filed = resolveRoute(['note', 'new', 'text', '--anchor-json', '{}', '--json'])!
  const target = commandAt(
    filed.route.owner === 'orch' ? orchProgram : hubProgram,
    filed.route.argv ?? [],
  )
  const accepted = target.options.map((option) => option.long)
  expect(accepted).toContain('--anchor-json')
  expect(accepted).toContain('--json')
})
