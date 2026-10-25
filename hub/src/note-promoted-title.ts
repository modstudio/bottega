import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { ARRAY_MCP_STATUS_WRITE_CONFIRM } from '../../shared/trackers.ts'
import type { HostedTask } from './hosted-tasks.ts'
import type { NoteClientOptions } from './note-client.ts'
import type { Attribution } from './task-attribution.ts'
import { setTaskThroughTracker } from './tracker-task-write.ts'

/**
 * The creating client sends the title with the promotion. This correction runs only when the task
 * the server returned carries a different title; a server older than this rule answers with the
 * note text. Only a delivered correction counts: a queued or rejected change leaves the hosted
 * record with the different title while the promotion reported success.
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
