// concern: context-service
/** Applies a verb's context effect without coupling its primary mutation to context storage. */
import {
  type ContextMomentEffect,
  type ContextMomentOutput,
} from './context-moment.ts'
import { contextItemRevision, setContextItem } from './context-service.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'

export type ContextMomentPorts = {
  set: typeof setContextItem
  revision: typeof contextItemRevision
}

const productionPorts: ContextMomentPorts = {
  set: setContextItem,
  revision: contextItemRevision,
}
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error))
const writeLine = (line: string, json: boolean, output: ContextMomentOutput) =>
  json ? output.error(line) : output.log(line)

/** Applies each mutation independently and reports storage failures without throwing. */
export async function applyContextMomentEffect(
  effect: ContextMomentEffect,
  json: boolean,
  output: ContextMomentOutput = { log: console.log, error: console.error },
  ports: ContextMomentPorts = productionPorts,
): Promise<void> {
  for (const line of effect.reports) writeLine(line, json, output)
  for (const item of effect.writes) {
    const selection =
      item.holder.kind === 'task'
        ? { task: item.holder.value }
        : { cursor: item.holder.value }
    const target =
      item.holder.kind === 'task' ? item.holder.value : `cursor ${item.holder.value}`
    try {
      const expectedRevision = await ports.revision({ ...selection, id: item.id })
      await ports.set({ ...selection, ...item, expectedRevision })
      writeLine(`context: wrote ${item.kind} ${item.id} on ${target}`, json, output)
    } catch (error) {
      const retry =
        error instanceof ContextWriteRefusalError || !item.retry ? '' : `; retry: ${item.retry}`
      writeLine(
        `context: could not write ${item.kind} on ${target}: ${detail(error)}${retry}`,
        json,
        output,
      )
    }
  }
}

/** Applies one gathered moment through the common CLI report path. */
export function applyContextMoment(
  moment: { taskKey: string | null; cursorRecordId: string | null; effect: ContextMomentEffect },
  json: boolean,
  output: ContextMomentOutput = { log: console.log, error: console.error },
  ports?: ContextMomentPorts,
): Promise<void> {
  return applyContextMomentEffect(moment.effect, json, output, ports)
}

/** Renders the non-fatal report for a moment that could not be gathered after an advance. */
export function workflowNextGatherFailure(
  taskKey: string | null,
  cursorRecordId: string,
  error: unknown,
): string {
  return `context: could not gather workflow-next on ${taskKey ?? `cursor ${cursorRecordId}`}: ${detail(error)}`
}
