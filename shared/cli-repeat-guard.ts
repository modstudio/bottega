type CliOption = {
  required: boolean
  optional: boolean
  variadic: boolean
  long?: string
  name(): string
  [REPEATABLE_OPTION]?: boolean
}

type CliCommand = {
  commands: CliCommand[]
  options: CliOption[]
  on(event: string, listener: (value: unknown) => void): unknown
  error(message: string): never
  hook(event: 'preAction', listener: () => void): unknown
}

export const REPEATABLE_OPTION = Symbol('repeatable CLI option')

export function repeatable<T extends object>(option: T): T {
  Object.assign(option, { [REPEATABLE_OPTION]: true })
  return option
}

export function refuseRepeatedOptions(root: CliCommand): void {
  for (const command of [root, ...root.commands.flatMap(descendants)]) {
    const received = new Map<CliOption, unknown[]>()
    for (const option of command.options) {
      if ((!option.required && !option.optional) || option.variadic || option[REPEATABLE_OPTION])
        continue
      command.on(`option:${option.name()}`, (value) => {
        const values = received.get(option) ?? []
        values.push(value)
        received.set(option, values)
      })
    }
    command.hook('preAction', () => {
      const repeated = [...received].find(([, values]) => values.length > 1)
      received.clear()
      if (!repeated) return
      const [option, values] = repeated
      const name = option.long?.replace(/^--/, '') ?? option.name()
      command.error(
        `--${name} may be supplied only once; received ${String(values[0])} and ${String(values[1])}`,
      )
    })
  }
}

function descendants(command: CliCommand): CliCommand[] {
  return [command, ...command.commands.flatMap(descendants)]
}
