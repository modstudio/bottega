// concern: workflows
/** Owns CLI-shaped reads and copies for workflow text attachments. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { flagValue } from '../cli/args.ts'
import { positive } from './workflow-command-arguments.ts'
import type { HubTaskReader } from './workflow-task-reference.ts'
import { workflowTextAttachmentToken } from './workflow-text.ts'
import {
  copyWorkflowTextForCursor,
  cursorForWorkflowTextCopy,
  productionWorkflowTextDocumentPorts,
  showWorkflowText,
  type WorkflowTextDocumentPorts,
  workflowTextCopyReport,
} from './workflow-text-copy.ts'

type WorkflowTextPrint = (value: unknown, line?: string) => void
type WorkflowTextCommandOptions = {
  hubTaskReader?: HubTaskReader
  workflowTextDocuments?: WorkflowTextDocumentPorts
}

export function showWorkflowTextCommand(argv: string[], print: WorkflowTextPrint): void {
  const shown = showWorkflowText(argv[3]!)
  if (shown.kind === 'live') {
    print(shown, shown.body)
    return
  }
  const line =
    `${PLATFORM_SLUG} task document ${shown.documentReference} preserves ${workflowTextAttachmentToken(shown.id)}; ` +
    `read it with: ${PLATFORM_SLUG} task doc show ${shown.documentReference}`
  print(shown, line)
}

export async function copyWorkflowTextCommand(
  argv: string[],
  print: WorkflowTextPrint,
  options: WorkflowTextCommandOptions = {},
): Promise<void> {
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  if (cursor === undefined) throw new Error('--cursor is required')
  const result = await copyWorkflowTextForCursor(
    cursorForWorkflowTextCopy(cursor),
    undefined,
    options.hubTaskReader,
    options.workflowTextDocuments ?? productionWorkflowTextDocumentPorts,
  )
  print(result, workflowTextCopyReport(result, cursor) || 'no uncopied workflow text')
}
