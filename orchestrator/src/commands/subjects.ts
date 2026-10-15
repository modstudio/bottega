// concern: cli
/** Registers project-subject commands. Must not own their behavior. */
import type { Command } from 'commander'
import { subjectCommand } from '../subject/subject-commands.ts'
import { log, optionFlags } from './support.ts'

type SubjectSpec = readonly [
  syntax: string,
  description: string,
  options: readonly (readonly [string, string])[],
]

const json = ['--json', 'print JSON output'] as const
const definition = ['--definition <value>', 'set the subject definition'] as const
const specs: readonly SubjectSpec[] = [
  ['list [project]', 'list project subjects', [['--retired', 'include retired subjects'], json]],
  ['add [project] [name]', 'add a project subject', [definition, json]],
  ['rename [project] [subject] [name]', 'rename a project subject', [json]],
  ['define [project] [subject]', 'change a project subject definition', [definition, json]],
  ['reorder [project] [subjects...]', 'set the order of project subjects', [json]],
  ['retire [project] [subject]', 'retire a project subject', [json]],
]

const values = (input: unknown[]) =>
  input
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string')

async function runSubject(verb: string, args: string[], command: Command): Promise<void> {
  await subjectCommand(verb, ['subject', verb, ...args], optionFlags(command.opts()), { log })
}

export function register(program: Command): void {
  const family = program
    .command('subject')
    .description('manage the subject vocabulary for projects')
    .action((command) => runSubject('list', [], command))
  for (const [syntax, description, options] of specs) {
    const verb = syntax.split(' ')[0]!
    const command = family.command(syntax).description(description)
    for (const [flags, optionDescription] of options) command.option(flags, optionDescription)
    command.action((...args: unknown[]) =>
      runSubject(verb, values(args.slice(0, -1)), args.at(-1) as Command),
    )
  }
}
