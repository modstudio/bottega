// concern: cli
/** Registers extracted logic-verb adapters. Must not own application decisions. */
import type { Command } from 'commander'
import { resolve } from 'node:path'
import { db } from '../db.ts'
import { serveAsk } from '../ask.ts'
import { migrateCommand, reconcileCommand } from '../database-commands.ts'
import { contractCommand } from '../contract-command.ts'
import { workflowCommand } from '../workflow-commands.ts'
import { lensCommand } from '../lens-commands.ts'
import { issueCommand, noteCommand, searchCommand, serveCommand, stateCommand } from '../record-commands.ts'
import { tellCommand } from '../mailbox-commands.ts'
import { peekCommand, resultCommand, waitCommand } from '../collection-commands.ts'
import { reclaimCommand } from '../reclaim-commands.ts'
import { setupAskCommand } from '../ask-commands.ts'
import { closeOutCommand } from '../close-out-command.ts'
import { spawnsCommand } from '../spawn-commands.ts'
import { pendingCommand } from '../pending-commands.ts'
import { metricCommand } from '../metric-commands.ts'
import { epicCommand } from '../epic-commands.ts'
import { jobsCommand } from '../job-commands.ts'
import { agentCommand, agentsCommand } from '../agent-commands.ts'
import { mcpCommand } from '../mcp-commands.ts'
import { monitorCommand } from '../monitor-commands.ts'
import { doCommand, pickPreviewCommand } from '../dispatch-cli-service.ts'
import { answerCommand, continueCommand, retryCommand } from '../run-message-commands.ts'
import { JOBS } from '../jobs.ts'
import { REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_REPRODUCED } from '../review-vocabulary.ts'
import { booleanOptions, cliFlags, rawArgv, valueOptions } from './support.ts'

const presentation = { log: (...values: unknown[]) => console.log(...values), error: (...values: unknown[]) => console.error(...values), setExitCode: (code: number) => { process.exitCode = code }, exit: (code: number): never => process.exit(code), now: Date.now, printRunId: (id: number) => process.stdout.write(`${id}\n`) }
const scoreSuffix = (jobName: string) => (JOBS[jobName]?.needs.writesRepo ? ' [drifted|partial|faithful]' : '') + (JOBS[jobName]?.findings ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]` : '')
const pairHint = (partner: { id: number; agent: string; reason?: string }) => `pair: run ${partner.id} (${partner.agent}) is comparable (${partner.reason ?? 'same task'}) — record with --better-than ${partner.id} | --worse-than ${partner.id} | --same-as ${partner.id}`

export function register(program: Command): void {
  booleanOptions(program.command('migrate'), ['backfill-spec-sha']).action(() => migrateCommand(presentation))
  program.command('reconcile <id>').action((id) => reconcileCommand(Number(id), presentation))
  program.command('contract <job>').action((job) => contractCommand(job, { write: (value) => process.stdout.write(value) }))
  booleanOptions(program.command('mcp'), ['config']).action((_options, command) => mcpCommand(cliFlags(rawArgv(command)).has('config'), resolve(new URL('../../../bin/orch', import.meta.url).pathname), presentation))

  const workflow = valueOptions(program.command('workflow [args...]'), ['version', 'file', 'reason', 'author', 'from', 'mode', 'arg'])
  booleanOptions(workflow, ['json']).action((_args, _options, command) => workflowCommand(rawArgv(command), presentation))
  const lens = valueOptions(program.command('lens [args...]'), ['title', 'question', 'excludes', 'slots', 'slots-file', 'enabled', 'reason', 'axis', 'name', 'body', 'body-file'])
  booleanOptions(lens, ['json']).action((_args, _options, command) => lensCommand(rawArgv(command), presentation))
  program.command('issue <key>').action((key) => issueCommand(key))
  const note = valueOptions(program.command('note <text>'), ['same-as']); booleanOptions(note, ['new']).action((text, _options, command) => { const flags = cliFlags(rawArgv(command)); return noteCommand(text, { sameAs: flags.flag('same-as') ? Number(flags.flag('same-as')) : undefined, new: flags.has('new') }, presentation) })
  valueOptions(program.command('state'), ['days']).action((_options, command) => { const value = cliFlags(rawArgv(command)).flag('days'); stateCommand(value ? Number(value) : null, presentation) })
  const search = valueOptions(program.command('search <query>'), ['limit']); booleanOptions(search, ['full', 'json']).action((query, _options, command) => { const flags = cliFlags(rawArgv(command)); searchCommand(query, { limit: Number(flags.flag('limit') ?? 20), full: flags.has('full'), json: flags.has('json') }, presentation) })
  const tell = valueOptions(program.command('tell <id> [message...]').allowUnknownOption(true), ['file']); booleanOptions(tell, ['ping']).action((id, _message, _options, command) => tellCommand(Number(id), rawArgv(command).slice(2), cliFlags(rawArgv(command)).has('ping'), presentation))
  const peek = valueOptions(program.command('peek <id>'), ['events']); booleanOptions(peek, ['json']).action((id, _options, command) => { const flags = cliFlags(rawArgv(command)); peekCommand(Number(id), { events: flags.flag('events') === undefined ? undefined : Number(flags.flag('events')), json: flags.has('json') }, presentation) })
  booleanOptions(program.command('result <id>'), ['quiet', 'artifacts']).action((_id, _options, command) => resultCommand(db(), rawArgv(command), scoreSuffix, presentation))
  valueOptions(program.command('wait <ids...>'), ['timeout']).action(async (_ids, _options, command) => waitCommand(db(), rawArgv(command)))
  const runFlags = (argv: string[]) => { const flags = cliFlags(argv); return { detach: flags.has('detach'), follow: flags.has('follow'), quiet: flags.has('quiet') } }
  const retry = valueOptions(program.command('retry <id>'), ['agent', 'model']); booleanOptions(retry, ['follow', 'detach', 'quiet']).action((id, _options, command) => { const argv = rawArgv(command), flags = cliFlags(argv); return retryCommand(Number(id), { agent: flags.flag('agent'), model: flags.flag('model'), flags: runFlags(argv) }, presentation) })
  const answer = valueOptions(program.command('answer <id> [message...]').allowUnknownOption(true), ['file']); booleanOptions(answer, ['follow', 'detach', 'quiet', 'record-only']).action((id, _message, _options, command) => { const argv = rawArgv(command); return answerCommand(Number(id), argv.slice(2), cliFlags(argv).has('record-only'), runFlags(argv), presentation) })
  const continuation = valueOptions(program.command('continue <id> [message...]').allowUnknownOption(true), ['file']); booleanOptions(continuation, ['follow', 'detach', 'quiet']).action((id, _message, _options, command) => { const argv = rawArgv(command); return continueCommand(Number(id), argv.slice(2), runFlags(argv), presentation) })
  const dispatch = valueOptions(program.command('do <job> [prompt...]'), ['agent', 'avoid', 'distinct-from', 'base', 'review', 'file', 'schema', 'model', 'transport', 'label', 'lens', 'seed', 'key', 'repo', 'cwd', 'deliverable', 'timeout'])
  booleanOptions(dispatch, ['carry', 'quiet', 'probe', 'follow', 'detach', 'porcelain', 'no-failover', 'keep-tree', 'no-wait-capacity']).option('--mcp [mode]').action((_job, _prompt, _options, command) => doCommand(rawArgv(command), { error: console.error, printRunId: (id) => process.stdout.write(`${id}\n`), cwd: process.cwd }))
  const pick = valueOptions(program.command('pick <job>'), ['agent', 'avoid', 'distinct-from', 'stack', 'lens']); pick.action((_job, _options, command) => pickPreviewCommand(rawArgv(command), { error: console.error, log: console.log, printRunId: (id) => process.stdout.write(`${id}\n`), cwd: process.cwd }))
  program.command('ask-server').action(() => serveAsk())
  program.command('setup-ask').action(() => setupAskCommand([process.execPath, new URL('../orch.ts', import.meta.url).pathname, 'ask-server'], presentation))
  const monitor = valueOptions(program.command('monitor'), ['limit', 'ack-notices']); booleanOptions(monitor, ['backstop', 'history', 'notices', 'json']).action((_options, command) => { const flags = cliFlags(rawArgv(command)); return monitorCommand({ ackNotices: flags.flag('ack-notices'), notices: flags.has('notices'), history: flags.has('history'), backstop: flags.has('backstop'), limit: Number(flags.flag('limit') ?? 20), json: flags.has('json') }, { ...presentation, write: (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve())) }) })
  const reclaim = booleanOptions(program.command('reclaim <kind> <subject>'), ['dry-run']); reclaim.action((kind, subject, _options, command) => reclaimCommand(kind, subject, cliFlags(rawArgv(command)).has('dry-run'), presentation))
  booleanOptions(program.command('close-out <id>'), ['non-blocking']).action((id, _options, command) => closeOutCommand(Number(id), cliFlags(rawArgv(command)).has('non-blocking'), presentation))
  valueOptions(program.command('spawns'), ['limit']).action((_options, command) => spawnsCommand(Number(cliFlags(rawArgv(command)).flag('limit') ?? 15), presentation))
  program.command('pending').action(() => pendingCommand(pairHint, presentation))
  const metric = valueOptions(program.command('metric [action]'), ['days', 'window']); metric.action((action, _options, command) => { const flags = cliFlags(rawArgv(command)); return metricCommand({ collect: action === 'collect', days: Number(flags.flag('days') ?? 30), window: Number(flags.flag('window') ?? 14) }, presentation) })
  program.command('serve').action(() => serveCommand(presentation))
  booleanOptions(program.command('epic <key>'), ['json']).action((key, _options, command) => epicCommand(key, cliFlags(rawArgv(command)).has('json'), presentation))
  booleanOptions(program.command('jobs'), ['json']).action((_options, command) => jobsCommand(cliFlags(rawArgv(command)).has('json'), presentation))
  const agent = valueOptions(program.command('agent [args...]'), ['harness', 'backend', 'model', 'base-url', 'context-tokens', 'jobs', 'prefer', 'max-concurrent', 'enabled', 'reason']); booleanOptions(agent, ['json']).action((_args, _options, command) => agentCommand(rawArgv(command), presentation))
  booleanOptions(program.command('agents'), ['json']).action((_options, command) => agentsCommand(cliFlags(rawArgv(command)).has('json'), presentation))
}
