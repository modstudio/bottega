// concern: context-service
/** Applies a verb's context effect without coupling its primary mutation to context storage. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ContextMomentEffect, ContextMomentOutput } from '../../../shared/context-moment.ts'
import { dropContextItem, setContextItem } from './context-service.ts'

export type ContextMomentPorts = {
  set: typeof setContextItem
  drop: typeof dropContextItem
}

const productionPorts: ContextMomentPorts = { set: setContextItem, drop: dropContextItem }
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error))
const writeLine = (line: string, json: boolean, output: ContextMomentOutput) =>
  json ? output.error(line) : output.log(line)

const setRetry = (taskKey: string, item: ContextMomentEffect['writes'][number]) =>
  `${PLATFORM_SLUG} agent context set --task ${shellQuote(taskKey)} --kind ${item.kind} ` +
  `--source ${shellQuote(item.source)} --id ${shellQuote(item.id)} ${shellQuote(item.body)}`

const dropRetry = (taskKey: string, id: string) =>
  `${PLATFORM_SLUG} agent context drop --task ${shellQuote(taskKey)} --id ${shellQuote(id)}`

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
  for (const item of effect.writes) {
    try {
      await ports.set({ task, ...item })
      writeLine(`context: wrote ${item.kind} ${item.id} on ${task}`, json, output)
    } catch (error) {
      writeLine(
        `context: could not write ${item.kind} on ${task}: ${detail(error)}; retry: ${setRetry(task, item)}`,
        json,
        output,
      )
    }
  }
  for (const item of effect.drops) {
    try {
      await ports.drop({ task, id: item.id })
      writeLine(`context: dropped ${item.kind} ${item.id} on ${task}`, json, output)
    } catch (error) {
      if (detail(error).startsWith('no context item ')) continue
      writeLine(
        `context: could not write ${item.kind} on ${task}: ${detail(error)}; retry: ${dropRetry(task, item.id)}`,
        json,
        output,
      )
    }
  }
}
