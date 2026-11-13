// concern: cli
/** Registers architect session resolution and stored context item verbs. */
import type { Command } from 'commander'
import { CONTEXT_ITEM_KINDS } from '../../../shared/context-item-vocabulary.ts'
import { contextBrief, renderContextBrief } from '../doc/context-brief.ts'
import {
  clearTaskContext,
  dropContextItem,
  getContext,
  setContextItem,
} from '../doc/context-service.ts'
import { recordSessionWorked, sessionWorkedTaskKeys } from '../doc/context-worked-adapter.ts'
import { recordBriefInjection, SESSION_START_SOURCES } from '../session/brief-injection.ts'
import { sessionContextCommand } from '../workflow/session-context.ts'
import { log } from './support.ts'

function registerWorked(context: Command): void {
  context
    .command('worked')
    .description('record and print the task keys worked by an architect session')
    .requiredOption('--session <id>', 'select architect session')
    .action(async (options) => {
      const keys = await sessionWorkedTaskKeys(options.session)
      const result = await recordSessionWorked(options.session, keys, 'precompact')
      log(result.body ?? 'worked: none')
    })
}

function registerClear(context: Command): void {
  context
    .command('clear')
    .description('remove every context item from one task holder')
    .requiredOption('--task <key>', 'select task holder')
    .action(async (options) => {
      const result = await clearTaskContext({ task: options.task })
      log(`context: cleared ${result.removed} items on ${result.task}`)
    })
}

function registerInjection(context: Command): void {
  context
    .command('record-injection')
    .description('record one SessionStart context injection')
    .requiredOption('--session <id>', 'select architect session')
    .requiredOption('--source <source>', `one of ${SESSION_START_SOURCES.join(', ')}`)
    .requiredOption('--bytes <count>', 'UTF-8 bytes in the final additional context', Number)
    .requiredOption('--lines <count>', 'lines in the final additional context', Number)
    .requiredOption('--chars <count>', 'characters in the final additional context', Number)
    .allowExcessArguments(false)
    .action(async (options) => {
      if (!SESSION_START_SOURCES.includes(options.source))
        throw new Error(`--source must be one of ${SESSION_START_SOURCES.join(', ')}`)
      log(
        JSON.stringify(
          await recordBriefInjection({
            sessionId: options.session,
            source: options.source,
            bytes: options.bytes,
            lines: options.lines,
            chars: options.chars,
          }),
        ),
      )
    })
}

const holderOptions = (command: Command) =>
  command
    .option('--task <key>', 'select task holder')
    .option('--session <id>', 'select session holder')

export function register(program: Command): void {
  const context = program
    .command('context')
    .description('manage stored architect context or resolve checkout context')
    .addHelpText(
      'after',
      '\nWrite context at these moments:\n' +
        '  workflow rule, question answer               write ruling or position\n' +
        '  task close                                  clears the task holder\n\n' +
        'Place each item once on the narrowest holder it binds in full: task for task-only points, epic for points binding every child, and session only when no single task or epic owns it.\n',
    )
    .option('--cwd <path>', 'resolve context for this checkout path')
    .option('--json', 'write the resolved context as JSON')
    .action((options) => {
      if (!options.cwd) throw new Error('pass --cwd or use context set|show|drop|clear')
      return sessionContextCommand({ cwd: options.cwd, json: Boolean(options.json) }, { log })
    })
  holderOptions(context.command('show').description('show stored context items'))
    .option('--json', 'write JSON')
    .action(async (options) => {
      const result = await getContext(options)
      if (options.json) return log(JSON.stringify(result))
      for (const item of result.items) log(`${item.id}  ${item.kind}  ${item.revision}`)
      for (const kind of result.missingRequired) log(`warning: missing required kind ${kind}`)
    })
  context
    .command('brief')
    .description('show the compact working context for an architect session')
    .requiredOption('--session <id>', 'select architect session')
    .option('--json', 'write JSON')
    .action(async (options) => {
      const result = await contextBrief(options.session)
      log(options.json ? JSON.stringify(result) : renderContextBrief(result))
    })
  registerInjection(context)
  registerWorked(context)
  holderOptions(context.command('set').description('create or revise one context item'))
    .requiredOption(
      '--kind <kind>',
      "ruling — Shmuel Barkin's decision; position — an agent's decision; fact — something learned that changes what the next agent does; pointer — where a durable artifact lives",
    )
    .requiredOption('--source <source>', 'item source')
    .requiredOption('--id <id>', 'stable item id')
    .option('--expected-revision <revision>', 'compare-and-set revision')
    .argument('<body>', 'item text')
    .action(async (body, options) => {
      if (!CONTEXT_ITEM_KINDS.includes(options.kind))
        throw new Error(`--kind must be one of ${CONTEXT_ITEM_KINDS.join(', ')}`)
      log(
        JSON.stringify(
          await setContextItem({ ...options, expectedRevision: options.expectedRevision, body }),
        ),
      )
    })
  holderOptions(context.command('drop').description('remove one context item'))
    .requiredOption('--id <id>', 'stable item id')
    .option('--expected-revision <revision>', 'compare-and-set revision')
    .action(async (options) => {
      const result = await dropContextItem({
        ...options,
        expectedRevision: options.expectedRevision,
      })
      if (!result.removed) throw new Error(`no context item ${result.holder}/${result.id}`)
      log(JSON.stringify(result))
    })
  registerClear(context)
}
