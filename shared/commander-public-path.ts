import type { Command } from 'commander'

export type PublicCommandInvocation = {
  publicPath: readonly string[]
  ownerPath: readonly string[]
}

const publicCommandPaths = new WeakMap<Command, readonly string[]>()

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
