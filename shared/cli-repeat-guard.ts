type CliOption = {
  required: boolean
  optional: boolean
  variadic: boolean
  long?: string
  name(): string
  [REPEATABLE_OPTION]?: boolean
}

type CliCommand = {
  readonly commands: readonly CliCommand[]
  readonly options: readonly CliOption[]
  on(event: string, listener: (value: unknown) => void): unknown
  error(message: string): never
  hook(event: 'preAction', listener: () => void): unknown
}

const REPEATABLE_OPTION = Symbol('repeatable CLI option')

export function repeatable<T extends object>(option: T): T {
  Object.assign(option, { [REPEATABLE_OPTION]: true })
  return option
}

export function isRepeatable(option: object): boolean {
  return Boolean((option as CliOption)[REPEATABLE_OPTION])
}

export function refuseRepeatedOptions(root: CliCommand): () => void {
  const receivedByCommand: Map<CliOption, unknown[]>[] = []
  for (const command of [root, ...root.commands.flatMap(descendants)]) {
    const received = new Map<CliOption, unknown[]>()
    receivedByCommand.push(received)
    for (const option of command.options) {
      if ((!option.required && !option.optional) || option.variadic || isRepeatable(option))
        continue
      command.on(`option:${option.name()}`, (value) => {
        const values = received.get(option) ?? []
        values.push(value)
        received.set(option, values)
      })
    }
    command.hook('preAction', () => {
      const repeated = [...received].find(([, values]) => values.length > 1)
      if (!repeated) return
      const [option, values] = repeated
      const name = option.long?.replace(/^--/, '') ?? option.name()
      command.error(
        `--${name} may be supplied only once; received ${String(values[0])} and ${String(values[1])}`,
      )
    })
  }
  return () => {
    for (const received of receivedByCommand) received.clear()
  }
}

function descendants(command: CliCommand): CliCommand[] {
  return [command, ...command.commands.flatMap(descendants)]
}
