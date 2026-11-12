// concern: cli
/** Registers architect session resolution and stored context item verbs. */
import type { Command } from 'commander'
import { contextBrief, renderContextBrief } from '../doc/context-brief.ts'
import { dropContextItem, getContext, setContextItem } from '../doc/context-service.ts'
import { staleContextForSession } from '../doc/context-stale-adapter.ts'
import { CONTEXT_ITEM_KINDS } from '../doc/doc-context-write.ts'
import { sessionContextCommand } from '../workflow/session-context.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  const context = program
    .command('context')
    .description('manage stored architect context or resolve checkout context')
    .addHelpText(
      'after',
      '\nWrite context at these moments:\n' +
        '  workflow next, run start, pr merge, task close  revise next-action\n' +
        '  workflow await                               write open-question\n' +
        '  workflow rule, question answer               write ruling\n\n' +
        'Place each item once on the narrowest holder it binds in full: task for task-only points, epic for points binding every child, and session only when no single task or epic owns it.\n',
    )
    .option('--cwd <path>', 'resolve context for this checkout path')
    .option('--json', 'write the resolved context as JSON')
    .action((options) => {
      if (!options.cwd) throw new Error('pass --cwd or use context set|show|drop')
      return sessionContextCommand({ cwd: options.cwd, json: Boolean(options.json) }, { log })
    })
  const holderOptions = (command: Command) =>
    command
      .option('--task <key>', 'select task holder')
      .option('--session <id>', 'select session holder')
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
  context
    .command('stale')
    .description(
      'list task holders with work in the last day after their newest next-action revision',
    )
    .requiredOption('--session <id>', 'select architect session')
    .option('--json', 'write JSON')
    .action(async (options) => {
      const result = await staleContextForSession(options.session)
      if (options.json) return log(JSON.stringify(result))
      for (const row of result)
        log(
          'reason' in row
            ? `${row.holder}  worked ${row.workedAt}  ${row.reason}`
            : `${row.holder}  worked ${row.workedAt}  next-action ${row.revisedAt ?? 'missing'}`,
        )
    })
  holderOptions(context.command('set').description('create or revise one context item'))
    .requiredOption('--kind <kind>', `one of ${CONTEXT_ITEM_KINDS.join(', ')}`)
    .requiredOption('--source <source>', 'item source')
    .option('--objection <text>', 'objection overcome by a ruling')
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
    .action(async (options) =>
      log(
        JSON.stringify(
          await dropContextItem({ ...options, expectedRevision: options.expectedRevision }),
        ),
      ),
    )
}
