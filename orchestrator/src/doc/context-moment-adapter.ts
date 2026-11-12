// concern: context-service
/** Applies a verb's context effect without coupling its primary mutation to context storage. */
import {
  type ContextMomentEffect,
  type ContextMomentOutput,
  contextDropCommand,
  contextSetCommand,
} from '../../../shared/context-moment.ts'
import { dropContextItem, setContextItem } from './context-service.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'

export type ContextMomentPorts = {
  set: typeof setContextItem
  drop: typeof dropContextItem
}

const productionPorts: ContextMomentPorts = { set: setContextItem, drop: dropContextItem }
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error))
const writeLine = (line: string, json: boolean, output: ContextMomentOutput) =>
  json ? output.error(line) : output.log(line)

/** Applies each mutation independently and reports storage failures without throwing. */
export async function applyContextMomentEffect(
  taskKey: string | null | undefined,
  effect: ContextMomentEffect,
  json: boolean,
  output: ContextMomentOutput = { log: console.log, error: console.error },
  ports: ContextMomentPorts = productionPorts,
): Promise<void> {
  const task = taskKey?.trim()
  if (!task) return
  let writesSucceeded = true
  const kept = effect.drops.length ? `; ${effect.drops.map((item) => item.id).join(', ')} kept` : ''
  for (const item of effect.writes) {
    try {
      await ports.set({ task, ...item })
      writeLine(`context: wrote ${item.kind} ${item.id} on ${task}`, json, output)
    } catch (error) {
      writesSucceeded = false
      const retry =
        error instanceof ContextWriteRefusalError ? '' : `; retry: ${contextSetCommand(task, item)}`
      writeLine(
        `context: could not write ${item.kind} on ${task}: ${detail(error)}${retry}${kept}`,
        json,
        output,
      )
    }
  }
  if (effect.writes.length && !writesSucceeded) return
  for (const item of effect.drops) {
    try {
      const result = await ports.drop({ task, id: item.id })
      if (!result.removed) continue
      writeLine(`context: dropped ${item.kind} ${item.id} on ${task}`, json, output)
    } catch (error) {
      writeLine(
        `context: could not drop ${item.kind} ${item.id} on ${task}: ${detail(error)}; retry: ${contextDropCommand(task, item.id)}`,
        json,
        output,
      )
    }
  }
}

/** Applies one gathered moment through the common CLI report path. */
export function applyContextMoment(
  moment: { taskKey: string | null; effect: ContextMomentEffect },
  json: boolean,
  output: ContextMomentOutput = { log: console.log, error: console.error },
  ports?: ContextMomentPorts,
): Promise<void> {
  return applyContextMomentEffect(moment.taskKey, moment.effect, json, output, ports)
}

/** Renders the non-fatal report for a moment that could not be gathered after an advance. */
export function workflowNextGatherFailure(
  taskKey: string | null,
  cursorRecordId: string,
  error: unknown,
): string {
  return `context: could not gather workflow-next on ${taskKey ?? `cursor ${cursorRecordId}`}: ${detail(error)}`
}
