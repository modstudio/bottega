import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { ARRAY_MCP_STATUS_WRITE_CONFIRM } from '../../shared/trackers.ts'
import type { HostedTask } from './hosted-tasks.ts'
import type { NoteClientOptions } from './note-client.ts'
import type { Attribution } from './task-attribution.ts'
import { setTaskThroughTracker } from './tracker-task-write.ts'

/**
 * The hosted server titles a promoted task with the note text, so the creating client corrects it
 * through the same hosted-aware write `bottega task set --title` uses, aimed at the destination the
 * promotion itself wrote to. Only a delivered correction counts: a queued change may never arrive
 * (a destination that cannot push task rows) and a rejected one is quarantined, and either leaves
 * the hosted record titled by the note text while the promotion reported success.
 */
export async function setPromotedTaskTitle(
  task: HostedTask,
  title: string,
  options: { hosted: NoteClientOptions; attribution: Attribution },
): Promise<void> {
  try {
    await setTaskThroughTracker(task.key, { recordId: task.id }, { title }, options.attribution, {
      confirm: ARRAY_MCP_STATUS_WRITE_CONFIRM,
      hosted: options.hosted,
      onHostedDelivery: (delivery) => {
        if (delivery.kind !== 'sent')
          throw new Error(`the correction was not delivered (${delivery.kind}: ${delivery.reason})`)
      },
    })
  } catch (error) {
    throw new Error(
      `hosted task ${task.key} was created with the note text as its title, but setting the title failed: ${(error as Error).message}. Finish with: ${PLATFORM_SLUG} task set ${task.key} --title "${title}"`,
    )
  }
}
