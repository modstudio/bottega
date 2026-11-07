import { Command, Option } from 'commander'

export class HubCommand extends Command {
  override createCommand(name?: string): Command {
    return new HubCommand(name)
  }
}

export class PresenceOption extends Option {
  constructor(flags: string, description?: string) {
    super(flags, description)
    this.negate = false
  }
}
