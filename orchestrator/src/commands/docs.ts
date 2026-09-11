// concern: cli
/** Registers documentation and register adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { canonCommand } from '../canon-commands.ts'
import { docCommand } from '../doc-commands.ts'
import { portCommand } from '../port-commands.ts'
import { projectCommand } from '../project-commands.ts'
import { booleanOptions, cliFlags, rawArgv, valueOptions, writeStdout } from './support.ts'

export function register(program: Command): void {
  const doc = valueOptions(program.command('doc [args...]'), ['scope', 'subject', 'title', 'file', 'reason', 'author', 'delivery', 'force-inject', 'cwd'])
  booleanOptions(doc, ['json']).action(async (_args, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    await docCommand(argv[1] ?? 'list', argv, flags, {
      log: console.log, error: console.error, write: (value) => process.stdout.write(value),
      stdinText: () => Bun.stdin.text(), stdinIsTTY: process.stdin.isTTY, cwd: process.cwd,
    })
  })

  const canon = valueOptions(program.command('canon [args...]'), ['cwd', 'job', 'slug', 'agent'])
  booleanOptions(canon, ['all', 'json', 'force']).action(async (_args, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    await import('../jobs.ts')
    await canonCommand(argv, flags, { log: console.log, exitCode: (code) => { process.exitCode = code }, cwd: process.cwd })
  })

  const port = valueOptions(program.command('port [args...]'), ['reason', 'sources', 'note', 'title', 'file'])
  booleanOptions(port, ['all', 'json', 'clear', 'dry-run', 'replace']).action(async (_args, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    await portCommand(argv[1], argv[2], argv, flags, {
      log: console.log, writeStdout, exitCode: (code) => { process.exitCode = code },
    })
  })

  const project = valueOptions(program.command('project [args...]'), ['name', 'stack', 'settings', 'path', 'axis', 'lens', 'version', 'reason'])
  booleanOptions(project, ['no-canon', 'canon', 'allow-incomplete', 'json', 'apply']).action((_args, _options, command) => {
    const argv = rawArgv(command)
    projectCommand(argv[1] ?? 'list', argv, cliFlags(argv), { log: console.log, cwd: process.cwd })
  })
}
