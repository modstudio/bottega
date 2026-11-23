// concern: task presentation
/** Owns the stable text rendering shared by local and confined task reads. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { TaskDocument, TaskDocumentSummary } from './task-document-types.ts'
import type { TaskRow } from './task-row.ts'
import type { TaskComment } from './task-types.ts'

export type ShownTask = {
  task: TaskRow
  comments: TaskComment[]
  documents: TaskDocumentSummary[]
}

export function printTaskRow(row: TaskRow): void {
  console.log(
    `${row.key.padEnd(10)} ${(row.status_category ?? '').padEnd(8)} ` +
      `${row.project.padEnd(12)} ${row.title ?? ''}`,
  )
}

export function printShownTask(shown: ShownTask): void {
  printTaskRow(shown.task)
  if (shown.task.revision !== undefined) console.log(`revision: ${shown.task.revision}`)
  if (shown.task.retired_reason) console.log(`retired: ${shown.task.retired_reason}`)
  if (shown.task.parent_key) console.log(`parent: ${shown.task.parent_key}`)
  if (shown.task.body) console.log(`\n${shown.task.body}`)
  if (shown.documents.length) {
    console.log('\ndocuments:')
    for (const document of shown.documents) {
      const role = document.role ? ` [${document.role}]` : ''
      console.log(
        `  ${document.label}${role}  ${document.title} — ${PLATFORM_SLUG} task doc show ${document.label}`,
      )
    }
  }
  for (const comment of shown.comments)
    console.log(
      `\n${comment.id}  ${comment.created_at}  ${comment.actor_name ?? 'unknown'}${comment.revision === undefined ? '' : `  revision ${comment.revision}`}\n${comment.body}`,
    )
}

export function printShownTaskDocument(item: TaskDocument): void {
  console.log(`${item.label}  ${item.task_key}${item.role ? ` [${item.role}]` : ''}  ${item.title}`)
  console.log(`version: ${item.version}`)
  if (item.body) console.log(`\n${item.body}`)
}
