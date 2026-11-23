// concern: cli
/** Registers architect session resolution and stored context item verbs. */
import type { Command } from 'commander'
import { CONTEXT_ITEM_KINDS } from '../../../shared/context-item-vocabulary.ts'
import {
  HOOK_EMISSION_KINDS,
  SESSION_START_SOURCES,
} from '../../../shared/record/schema-session.ts'
import { log } from './support.ts'

const required = (value: string, name: string) => {
  if (!value) throw new Error(`${name} is required`)
}

const wholeNonnegative = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer`)
}

function registerClear(context: Command): void {
  context
    .command('clear')
    .description('remove every context item from one task holder')
    .requiredOption('--task <key>', 'select task holder')
    .action(async (options) => {
      const { clearTaskContext } = await import('../doc/context-service.ts')
      const result = await clearTaskContext({ task: options.task })
      log(
        `context: cleared ${result.removed} items on ${result.task}, already absent ${result.alreadyAbsent}`,
      )
    })
}

function registerHealth(context: Command): void {
  context
    .command('health')
    .description('report whether stored architect context is managed correctly')
    .option('--since <duration>', 'include recorded review and injection rows by age (default: 7d)')
    .option('--project <name>', 'select one project')
    .option('--session <id>', 'select one session')
    .option('--json', 'write JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const [{ contextHealthReport }, { renderContextHealth }] = await Promise.all([
        import('../context-health/context-health-adapter.ts'),
        import('../context-health/context-health-render.ts'),
      ])
      const report = await contextHealthReport({
        since: options.since,
        project: options.project,
        session: options.session,
      })
      log(options.json ? JSON.stringify(report) : renderContextHealth(report))
      if (report.exitCode !== 0) process.exitCode = report.exitCode
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
      const { recordBriefInjection } = await import('../session/brief-injection.ts')
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

function registerEmission(context: Command): void {
  context
    .command('record-emission')
    .description('record one product-hook output')
    .requiredOption('--session <id>', 'select architect session')
    .requiredOption('--event <event>', 'hook event name')
    .requiredOption('--hook <hook>', 'product hook name')
    .requiredOption('--kind <kind>', `one of ${HOOK_EMISSION_KINDS.join(', ')}`)
    .requiredOption('--chars <count>', 'characters in the output', Number)
    .requiredOption('--lines <count>', 'lines in the output', Number)
    .requiredOption('--hash <sha256>', 'normalized output sha256')
    .allowExcessArguments(false)
    .action(async (options) => {
      required(options.session, 'session id')
      required(options.event, 'event')
      required(options.hook, 'hook')
      if (!HOOK_EMISSION_KINDS.includes(options.kind))
        throw new Error(`--kind must be one of ${HOOK_EMISSION_KINDS.join(', ')}`)
      wholeNonnegative(options.chars, 'chars')
      wholeNonnegative(options.lines, 'lines')
      if (!/^[0-9a-f]{64}$/.test(options.hash)) throw new Error('--hash must be a lowercase sha256')
      log(
        JSON.stringify(
          (await import('../session/hook-emission.ts')).recordHookEmission({
            sessionId: options.session,
            event: options.event,
            hook: options.hook,
            kind: options.kind,
            chars: options.chars,
            lines: options.lines,
            textHash: options.hash,
          }),
        ),
      )
    })
}

const holderOptions = (command: Command) =>
  command
    .option('--task <key>', 'select task holder')
    .option('--session <id>', 'select session holder')
    .option('--cursor <record-id>', 'select cursor holder')

const requireHolder = (options: { task?: string; session?: string; cursor?: string }) => {
  if ([options.task, options.session, options.cursor].filter(Boolean).length !== 1)
    throw new Error('select exactly one of --task, --session or --cursor')
}

export function register(program: Command): void {
  const context = program
    .command('context')
    .description('manage stored architect context or resolve checkout context')
    .addHelpText(
      'after',
      '\nWrite context at these moments:\n' +
        '  workflow rule, question answer               write ruling or position\n' +
        '  task close                                  clears the task holder at once\n' +
        '  machine sweep                               clears tasks that reached done another way\n\n' +
        'Place each item once on the narrowest holder it binds in full: task for task-only points, epic for points binding every child, and session only when no single task or epic owns it.\n',
    )
    .option('--cwd <path>', 'resolve context for this checkout path')
    .option('--json', 'write the resolved context as JSON')
    .action(async (options) => {
      if (!options.cwd) throw new Error('pass --cwd or use context set|show|drop|clear')
      return (await import('../workflow/session-context.ts')).sessionContextCommand(
        { cwd: options.cwd, json: Boolean(options.json) },
        { log },
      )
    })
  holderOptions(context.command('show').description('show stored context items'))
    .option('--json', 'write JSON')
    .action(async (options) => {
      requireHolder(options)
      const { getContext } = await import('../doc/context-service.ts')
      const result = await getContext(options)
      if (options.json) return log(JSON.stringify(result))
      for (const item of result.items) log(`${item.id}  ${item.kind}  ${item.revision}`)
      for (const cursor of result.cursorHolders) {
        log(`Cursor ${cursor.cursor} ${cursor.workflow} ${cursor.mode} (${cursor.project})`)
        for (const item of cursor.items) log(`  ${item.id}  ${item.kind}  ${item.revision}`)
      }
    })
  context
    .command('brief')
    .description('show the compact working context for an architect session')
    .requiredOption('--session <id>', 'select architect session')
    .option('--json', 'write JSON')
    .action(async (options) => {
      const { contextBrief, renderContextBrief } = await import('../doc/context-brief.ts')
      const result = await contextBrief(options.session)
      log(options.json ? JSON.stringify(result) : renderContextBrief(result))
    })
  context
    .command('review')
    .description('review stored context items when the measured interval is due')
    .requiredOption('--session <id>', 'select architect session')
    .option('--json', 'write JSON')
    .action(async (options) => {
      const { reviewContext } = await import('../session/context-review.ts')
      const result = await reviewContext(options.session)
      if (options.json) return log(JSON.stringify(result))
      if ('review' in result) log(result.review)
    })
  registerInjection(context)
  registerEmission(context)
  registerHealth(context)
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
      requireHolder(options)
      if (!CONTEXT_ITEM_KINDS.includes(options.kind))
        throw new Error(`--kind must be one of ${CONTEXT_ITEM_KINDS.join(', ')}`)
      const result = await (await import('../doc/context-service.ts')).setContextItem({
        ...options,
        expectedRevision: options.expectedRevision,
        body,
      })
      log(JSON.stringify(result))
      if (result.warning) console.error(result.warning)
    })
  holderOptions(context.command('drop').description('remove one context item'))
    .requiredOption('--id <id>', 'stable item id')
    .option('--expected-revision <revision>', 'compare-and-set revision')
    .action(async (options) => {
      requireHolder(options)
      const result = await (await import('../doc/context-service.ts')).dropContextItem({
        ...options,
        expectedRevision: options.expectedRevision,
      })
      if (!result.removed && !result.alreadyAbsent)
        throw new Error(`no context item ${result.holder}/${result.id}`)
      log(JSON.stringify(result))
    })
  registerClear(context)
}
