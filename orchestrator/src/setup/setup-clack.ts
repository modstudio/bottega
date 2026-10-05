// concern: setup-clack
/** Adapts the interactive setup presentation port to the bought prompt library. */

import { confirm, intro, isCancel, log, note, select, spinner } from '@clack/prompts'
import { SETUP_CANCEL, type SetupPrompter, type SetupSelectOption } from './setup-interactive.ts'

export const clackSetupPrompter: SetupPrompter = {
  line: (message) => log.info(message),
  note: (message, title) => note(message, title),
  select: async (input) => {
    const answer = await select<string>({
      message: input.message,
      options: input.options.map((option: SetupSelectOption) => ({
        value: option.value,
        label: option.label,
        hint: option.hint,
      })),
      initialValue: input.initialValue,
    })
    return isCancel(answer) ? SETUP_CANCEL : answer
  },
  confirm: async (input) => {
    const answer = await confirm(input)
    return isCancel(answer) ? SETUP_CANCEL : answer
  },
}

export function introduceSetup(folders: string[]): void {
  intro('Setup')
  log.info(`Inspecting ${folders.join(', ')}`)
  log.info('Use --in <folder> to change the folders inspected.')
}

/**
 * A cancel while the spinner runs arrives two ways. A signal reaches the spinner's `onCancel`
 * and the process keeps running. A Ctrl-C keypress makes the library exit the process itself
 * without calling `onCancel`, so an exit listener is the only place the caller can still set
 * an exit code. `onCancel` runs synchronously on either path.
 */
export async function gatherSetupPlan<T>(
  gather: () => Promise<T>,
  onCancel: () => void,
): Promise<T | typeof SETUP_CANCEL> {
  let gathering = true
  let cancelGather!: () => void
  const cancelled = new Promise<typeof SETUP_CANCEL>((resolve) => {
    cancelGather = () => {
      onCancel()
      resolve(SETUP_CANCEL)
    }
  })
  const exitedWhileGathering = () => {
    if (gathering) onCancel()
  }
  process.on('exit', exitedWhileGathering)
  const progress = spinner({
    cancelMessage: 'Setup cancelled; nothing was changed.',
    onCancel: cancelGather,
  })
  progress.start('Gathering setup plan')
  const gathered = gather()
    .then(
      (plan) => {
        if (!progress.isCancelled) progress.stop('Setup plan ready')
        return plan
      },
      (error) => {
        if (!progress.isCancelled) progress.error('Could not gather setup plan')
        throw error
      },
    )
    .finally(() => {
      gathering = false
      process.removeListener('exit', exitedWhileGathering)
    })
  return Promise.race([gathered, cancelled])
}
