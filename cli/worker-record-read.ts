// concern: confined worker CLI record reads
/** Routes the three run-scoped worker reads through the host ask server before stores load. */

import type { HostedDocument } from '../hub/src/hosted-tasks.ts'
import { resolveHostedUrl } from '../hub/src/hosted-url.ts'
import { hostedWriteMode } from '../hub/src/hosted-write-mode.ts'
import type { HostedTaskDetail } from '../hub/src/task-hosted-record.ts'
import type { ShownWorkflowText } from '../orchestrator/src/workflow/workflow-text-commands.ts'
import { WORKER_MCP_SERVER_NAME } from '../shared/brand.ts'
import { type CallerClassification, classifyCaller } from '../shared/caller-classification.ts'
import { WORKER_READ_TOOLS } from '../shared/worker-read-tools.ts'

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`)
  return value
}

function positionalReference(argv: readonly string[], start: number): string | undefined {
  for (let index = start; index < argv.length; index += 1) {
    const value = argv[index]!
    if (value === '--project') {
      index += 1
      continue
    }
    if (value === '--json' || value === '--fresh') continue
    if (!value.startsWith('-')) return value
  }
  return undefined
}

function workerReadRoute(argv: readonly string[]): 'task' | 'document' | 'workflow' | null {
  if (argv[0] === 'task' && argv[1] === 'show') return 'task'
  if (
    argv[0] === 'task' &&
    (argv[1] === 'doc' || argv[1] === 'document') &&
    argv[2] === 'show'
  )
    return 'document'
  if (argv[0] === 'workflow' && argv[1] === 'text' && argv[2] === 'show') return 'workflow'
  return null
}

export function workerRecordReadCliRefusal(input: {
  route: keyof typeof WORKER_READ_TOOLS | null
  callerKind: CallerClassification['kind']
  codexSandbox: boolean
  hostedConfigured: boolean
}): string | null {
  if (
    !input.route ||
    input.callerKind !== 'worker' ||
    !input.codexSandbox ||
    !input.hostedConfigured
  )
    return null
  const tool = WORKER_READ_TOOLS[input.route]
  return `a codex worker reads this record with the ${WORKER_MCP_SERVER_NAME} MCP tool ${tool}; the CLI can't reach the record session from codex's sandbox`
}

/** Return null when the normal CLI owner should handle this invocation. */
export async function dispatchWorkerRecordRead(argv: string[]): Promise<number | null> {
  const route = workerReadRoute(argv)
  const callerKind = classifyCaller(process.env).kind
  const worker = callerKind === 'worker'
  const askUrl = Boolean(process.env.BOTTEGA_ASK_URL?.trim())
  const refusal = workerRecordReadCliRefusal({
    route,
    callerKind,
    codexSandbox: Boolean(process.env.CODEX_SANDBOX?.trim()),
    hostedConfigured: hostedWriteMode(resolveHostedUrl()) === 'hosted-configured',
  })
  if (refusal) {
    console.error(refusal)
    return 1
  }
  if (!route || !worker || !askUrl) return null
  try {
    const json = argv.includes('--json')
    const value = positionalReference(argv, route === 'task' ? 2 : 3)
    if (!value) throw new Error(`missing ${route} reference`)
    if (argv.includes('--fresh'))
      throw new Error("worker record scope is read-only; '--fresh' is outside that scope")
    const project = option(argv, '--project')
    const [
      { hostedTaskRow, hostedComment, hostedTaskDocumentSummary },
      { printShownTask, printShownTaskDocument },
      { callWorkerRecordRead },
      { workflowTextAttachmentId },
      { workflowTextShowLine },
    ] = await Promise.all([
      import('../hub/src/task-hosted-record.ts'),
      import('../hub/src/task-print.ts'),
      import('../orchestrator/src/ask/worker-record-read-client.ts'),
      import('../orchestrator/src/workflow/workflow-text.ts'),
      import('../orchestrator/src/workflow/workflow-text-commands.ts'),
    ])
    const readOptions = project ? { project } : {}
    if (route === 'task') {
      const detail = await callWorkerRecordRead<HostedTaskDetail>(WORKER_READ_TOOLS.task, {
        key: value,
        ...readOptions,
      })
      const shown = {
        task: hostedTaskRow(detail.task),
        comments: detail.comments.map(hostedComment),
        documents: detail.documents.map(hostedTaskDocumentSummary),
      }
      if (json) console.log(JSON.stringify(shown))
      else printShownTask(shown)
    } else if (route === 'document') {
      const hosted = await callWorkerRecordRead<HostedDocument>(WORKER_READ_TOOLS.document, {
        reference: value,
        ...readOptions,
      })
      const document = hostedTaskDocumentSummary(hosted)
      if (json) console.log(JSON.stringify(document))
      else printShownTaskDocument(document)
    } else {
      const id = workflowTextAttachmentId(value)
      const shown = await callWorkerRecordRead<ShownWorkflowText>(WORKER_READ_TOOLS.workflow, {
        id,
        ...readOptions,
      })
      if (json) console.log(JSON.stringify(shown))
      else console.log(workflowTextShowLine(shown))
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
