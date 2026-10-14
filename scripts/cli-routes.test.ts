import { expect, test } from 'bun:test'
import type { Command } from 'commander'
import { ROUTES } from '../cli/routes.ts'
import { program as hubProgram } from '../hub/src/cli-program.ts'
import { program as orchProgram } from '../orchestrator/src/cli/program.ts'

function commandExists(program: Command, path: readonly string[]): boolean {
  let current = program
  for (const name of path) {
    const next = current.commands.find((candidate) => candidate.name() === name)
    if (!next) return false
    current = next
  }
  return true
}

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
