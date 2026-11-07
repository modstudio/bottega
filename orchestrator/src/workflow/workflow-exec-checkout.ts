// concern: workflows
/** Pure checkout agreement for workflow exec. Must not know filesystems, processes, or clocks. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export function workflowExecCommandCwd(command: string[]): string | null {
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index]!
    if (argument === '--') return null
    if (argument === '--cwd') {
      const directory = command[index + 1]
      return directory && directory !== '--' ? directory : null
    }
    if (argument.startsWith('--cwd=')) return argument.slice('--cwd='.length)
  }
  return null
}

export function workflowExecCheckoutRefusal(
  command: string[],
  execCheckout: string,
  commandCheckout: string | null,
): string | null {
  const directory = workflowExecCommandCwd(command)
  if (directory === null || commandCheckout === execCheckout) return null
  return `workflow exec runs in ${execCheckout} but the command names --cwd ${directory}; run it as: ${PLATFORM_SLUG} workflow exec --cwd ${directory} -- ${command.join(' ')}`
}
