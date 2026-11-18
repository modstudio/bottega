import type { Command } from 'commander'
import { CALLER_ENVIRONMENT_KEY, CALLER_TOKEN_MAX_LENGTH } from './record-caller.ts'

export type PublicCommandInvocation = {
  publicPath: readonly string[]
  ownerPath: readonly string[]
}

const publicCommandPaths = new WeakMap<Command, readonly string[]>()

export function cliCallerEnvironmentValue(
  parentValue: string | undefined,
  command: Command,
): string {
  const publicPath = publicCommandPaths.get(command)
  let ownValue: string
  if (publicPath) ownValue = `cli:${publicPath.join('/')}`
  else {
    const names: string[] = []
    for (let current: Command | null = command; current?.parent; current = current.parent) {
      names.unshift(current.name())
    }
    ownValue = `cli:${names.join('/')}`
  }
  return `${ownValue}${parentValue ? `.${parentValue}` : ''}`.slice(0, CALLER_TOKEN_MAX_LENGTH)
}

export type CliCallerDispatch = <T>(work: () => Promise<T>) => Promise<T>

export function installCliCallerDispatch(program: Command): CliCallerDispatch {
  let active = false
  program.hook('preAction', (_rootCommand, actionCommand) => {
    if (!active) return
    process.env[CALLER_ENVIRONMENT_KEY] = cliCallerEnvironmentValue(
      process.env[CALLER_ENVIRONMENT_KEY],
      actionCommand,
    )
  })
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const parentCaller = process.env[CALLER_ENVIRONMENT_KEY]
    active = true
    try {
      return await work()
    } finally {
      active = false
      if (parentCaller === undefined) delete process.env[CALLER_ENVIRONMENT_KEY]
      else process.env[CALLER_ENVIRONMENT_KEY] = parentCaller
    }
  }
}

export function takesVariadicArgument(command: Command): boolean {
  return command.registeredArguments.some((argument) => argument.variadic)
}

function commandRoot(command: Command): Command {
  let root = command
  while (root.parent) root = root.parent
  return root
}

export function publicCommandUsage(command: Command): string {
  const publicPath = publicCommandPaths.get(command)
  if (publicPath) return `${commandRoot(command).name()} ${publicPath.join(' ')} ${command.usage()}`
  const names: string[] = []
  for (let current: Command | null = command; current; current = current.parent) {
    names.unshift(current.name())
  }
  return `${names.join(' ')} ${command.usage()}`
}

export function applyPublicCommandPath(
  root: Command,
  argv: readonly string[],
  invocation?: PublicCommandInvocation,
): void {
  if (!invocation) return
  let command = root
  let consumed = 0
  while (consumed < argv.length) {
    const child = command.commands.find((candidate) =>
      [candidate.name(), ...candidate.aliases()].includes(argv[consumed]!),
    )
    if (!child) break
    command = child
    consumed += 1
  }
  const suffix = argv.slice(invocation.ownerPath.length, consumed)
  publicCommandPaths.set(command, [...invocation.publicPath, ...suffix])
}
