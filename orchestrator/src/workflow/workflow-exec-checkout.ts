// concern: workflows
/** Pure checkout agreement for workflow exec. The last child --cwd before -- decides. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export function workflowExecCommandCwd(command: string[]): string | null {
  let directory: string | null = null
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index]!
    if (argument === '--') break
    if (argument === '--cwd') {
      const value = command[index + 1]
      if (value === '--') break
      if (value) directory = value
      index += 1
      continue
    }
    if (argument.startsWith('--cwd=')) directory = argument.slice('--cwd='.length)
  }
  return directory
}

const shellQuote = (argument: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`

export function workflowExecCheckoutRefusal(
  command: string[],
  execCheckout: string,
  commandDirectory: string | null,
  commandCheckout: string | null,
): string | null {
  if (commandDirectory === null || commandCheckout === execCheckout) return null
  return `workflow exec runs in ${execCheckout} but the command names --cwd ${commandDirectory}; run it as: ${PLATFORM_SLUG} workflow exec --cwd ${shellQuote(commandDirectory)} -- ${command.map(shellQuote).join(' ')}`
}
