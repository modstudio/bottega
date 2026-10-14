import { Command, InvalidArgumentError, Option } from 'commander'

let parseGeneration = 0

export class HubCommand extends Command {
  static beginParse(): void {
    parseGeneration += 1
  }

  override createCommand(name?: string): Command {
    return new HubCommand(name)
  }

  override createOption(flags: string, description?: string): Option {
    const option = new Option(flags, description)
    if (!option.required && !option.optional) return option
    let seenGeneration = -1
    return option.argParser((value: string) => {
      if (seenGeneration === parseGeneration)
        throw new InvalidArgumentError(`option '${option.flags}' may not be repeated`)
      seenGeneration = parseGeneration
      return value
    })
  }
}

export class PresenceOption extends Option {
  constructor(flags: string, description?: string) {
    super(flags, description)
    this.negate = false
  }
}
