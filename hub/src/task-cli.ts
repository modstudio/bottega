import { readFileSync, writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { PresenceOption } from './cli-command.ts'
import { requireDatabase } from './db.ts'
import { credentials, Mcp } from './mcp.ts'
import { projects } from './projects.ts'
import {
  commentTask,
  deleteTaskComment,
  editTaskComment,
  createTask,
  DuplicateTaskError,
  duplicateCandidates,
  listTasks,
  setTask,
  showTask,
} from './task.ts'
import { cliAttribution } from './task-attribution.ts'
import { closeThenPrune } from './task-close.ts'
import {
  createTaskDocument,
  deleteTaskDocument,
  getTaskDocument,
  listTaskDocuments,
  updateTaskDocument,
} from './task-document.ts'
import { runHostedTaskMaintenance } from './task-hosted-cli.ts'
import { importTasks } from './task-import.ts'
import { createAdvertisedTrackerTaskKey } from './tracker-new.ts'
import { createTrackerOwnedTask, refreshTrackerTask } from './tracker-task-cli.ts'

type TaskOptions = {
  abandon?: string
  allowDuplicate?: string
  assignee?: string
  body?: string
  bodyFile?: string
  confirm?: string
  dryRun?: boolean
  force?: boolean
  fresh?: boolean
  json?: boolean
  keepBranches?: boolean
  noParent?: boolean
  noRole?: boolean
  onlyPresentElsewhere?: boolean
  parent?: string
  project?: string
  repair?: boolean
  role?: string
  status?: string
  title?: string
  version?: string
}

const open = () => requireDatabase()
const required = (options: TaskOptions, name: keyof TaskOptions): string => {
  const value = options[name]
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`--${camelToDash(name)} is required`)
  return value
}
const optional = (options: TaskOptions, name: keyof TaskOptions): string | undefined => {
  const value = options[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`--${camelToDash(name)} is required`)
  return value
}
const camelToDash = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

function taskBody(options: TaskOptions): string | undefined {
  if (options.body !== undefined && options.bodyFile !== undefined)
    throw new Error('--body and --body-file are mutually exclusive')
  if (options.bodyFile !== undefined) return readFileSync(required(options, 'bodyFile'), 'utf8')
  return options.body === undefined ? undefined : required(options, 'body')
}

function printTaskRow(row: ReturnType<typeof showTask>['task']): void {
  console.log(
    `${row.key.padEnd(10)} ${(row.status_category ?? '').padEnd(8)} ` +
      `${row.project.padEnd(12)} ${row.title ?? ''}`,
  )
}

async function createTaskCommand(options: TaskOptions): Promise<void> {
  const project = required(options, 'project')
  const title = required(options, 'title')
  const body = taskBody(options)
  const override = options.allowDuplicate
  const delay = Number(process.env.HUB_TEST_DUPLICATE_DELAY_MS ?? 0)
  const afterDuplicateSearch =
    delay > 0
      ? () => {
          const marker = process.env.HUB_TEST_DUPLICATE_MARKER
          if (marker) writeFileSync(marker, '')
          Bun.sleepSync(delay)
        }
      : undefined
  try {
    if (override !== undefined && !override.trim())
      throw new Error('--allow-duplicate requires a non-empty reason')
    const input = {
      project,
      title,
      body,
      status: options.status,
      parent: options.parent,
    }
    const trackerKey = await createTrackerOwnedTask(input, {
      allowDuplicateReason: override,
      afterDuplicateSearch,
    })
    if (trackerKey) console.log(trackerKey)
    else
      console.log(
        (
          await createTask(input, {
            allowDuplicateReason: override,
            afterDuplicateSearch,
            attribution: await cliAttribution(),
          })
        ).key,
      )
  } catch (error) {
    if (!(error instanceof DuplicateTaskError)) throw error
    throw new Error(
      [
        'possible duplicate tasks:',
        ...error.candidates.map(
          (candidate) =>
            `${candidate.key} [${candidate.status ?? 'unknown'}] score ${candidate.score.toFixed(3)}  ${candidate.title}`,
        ),
        '',
        'Refusing to create a duplicate. Pass --allow-duplicate "reason" to override.',
      ].join('\n'),
    )
  }
}

async function showTaskCommand(key: string, options: TaskOptions): Promise<void> {
  const freshness = options.fresh ? await refreshTrackerTask(key, options.project) : null
  const shown = freshness?.shown ?? showTask(key, { project: options.project })
  if (options.json) {
    console.log(
      JSON.stringify(
        freshness?.trackerRead
          ? {
              ...shown,
              tracker_comments_verifiable: freshness.commentsVerifiable,
            }
          : shown,
      ),
    )
    return
  }
  printTaskRow(shown.task)
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
      `\n${comment.id}  ${comment.created_at}  ${comment.actor_name ?? 'unknown'}\n${comment.body}`,
    )
}

async function closeTask(key: string, options: TaskOptions): Promise<void> {
  const { closed, pruned, pruneError, claimReleaseError } = await closeThenPrune(
    key,
    { project: options.project },
    Boolean(options.keepBranches),
    optional(options, 'abandon'),
    await cliAttribution(),
    {},
  )
  printTaskRow(closed)
  if (claimReleaseError) {
    console.error(`claim release failed: ${claimReleaseError.message}`)
    console.error(
      `retry: ${PLATFORM_SLUG} board claim release-task ${closed.key} --project ${closed.project} --json`,
    )
    process.exitCode = 1
  }
  if (pruneError) {
    console.error(`branch prune failed: ${pruneError.message}`)
    console.error(
      `retry: ${PLATFORM_SLUG} tree branch prune --project ${closed.project} --key ${closed.key}`,
    )
    process.exitCode = 1
    return
  }
  if (!pruned) return
  console.log(`branches: deleted ${pruned.deleted.length}; kept ${pruned.kept.length}`)
  for (const branch of pruned.operator)
    console.log(
      `${branch.state}: ${branch.branch} (${branch.commitsNotOnTrunk} commits not on trunk); ${branch.command}`,
    )
}

function taskOptions(command: Command): TaskOptions {
  return command.opts() as TaskOptions
}

const commonBody = (command: Command) =>
  command
    .option('--body <text>', 'use this text as the task body')
    .option('--body-file <path>', 'read the task body from this file')

function registerTaskCreationCommands(task: Command): void {
  commonBody(
    task
      .command('new')
      .description('create a task in its configured destination')
      .option('--project <X>', 'name the task project')
      .option('--title <text>', 'set the task title')
      .option('--status <Y>', 'set the initial task status')
      .option('--parent <key>', 'set the parent task key')
      .option('--allow-duplicate <reason>', 'allow a possible duplicate for this reason'),
  ).action(async (_options, command) => {
    open()
    await createTaskCommand(taskOptions(command))
  })
  task
    .command('duplicates')
    .description('find possible duplicate tasks for a title')
    .option('--project <X>', 'search tasks in this project')
    .option('--title <text>', 'find tasks similar to this title')
    .option('--json', 'write the candidates as JSON')
    .action((_options, command) => {
      open()
      const options = taskOptions(command)
      const rows = duplicateCandidates(
        listTasks({ project: required(options, 'project') }),
        required(options, 'title'),
      )
      if (!options.json) throw new Error(`${PLATFORM_SLUG} task duplicates requires --json`)
      console.log(JSON.stringify(rows))
    })
  task
    .command('tracker-new')
    .description('create a task directly in the configured tracker')
    .option('--project <X>', 'name the tracker project')
    .option('--title <text>', 'set the task title')
    .option('--body <text>', 'set the task body')
    .action(async (_options, command) => {
      open()
      const options = taskOptions(command)
      const project = projects().find(
        (candidate) => candidate.name === required(options, 'project'),
      )
      if (!project) throw new Error(`unknown project '${options.project}'`)
      const tracker = project.settings.tracker
      const env = tracker?.envPrefix ?? project.settings.envPrefix
      if (!tracker || !env)
        throw new Error(`project ${project.name} has no usable tracker configured`)
      const auth = await credentials(env)
      if (!auth) throw new Error(`credentials for ${project.name} tracker do not resolve`)
      const status = tracker.openStatuses?.[0]
      if (!status) throw new Error(`project ${project.name} has no open tracker status configured`)
      const client = new Mcp(auth.url, auth.token)
      try {
        await client.initialize()
        console.log(
          await createAdvertisedTrackerTaskKey(client, project, {
            title: required(options, 'title'),
            body: required(options, 'body'),
            status,
          }),
        )
      } finally {
        await client.close()
      }
    })
}

function registerTaskQueryCommands(task: Command): void {
  task
    .command('list')
    .description('list tasks from the local record')
    .option('--project <X>', 'limit tasks to this project')
    .option('--status <Y>', 'limit tasks to this status')
    .option('--parent <key>', 'limit tasks to this parent task')
    .option('--json', 'write the task rows as JSON')
    .action((_options, command) => {
      open()
      const options = taskOptions(command)
      const rows = listTasks({
        project: options.project,
        status: options.status,
        parent: options.parent,
      })
      if (options.json) console.log(JSON.stringify(rows))
      else if (!rows.length) console.log('no tasks')
      else rows.forEach(printTaskRow)
    })
  task
    .command('show <key>')
    .description('show a task with its documents and comments')
    .option('--project <X>', 'resolve the task in this project')
    .option('--json', 'write the task record as JSON')
    .option('--fresh', 'refresh the task from its tracker before showing it')
    .action(async (key, _options, command) => {
      open()
      await showTaskCommand(key, taskOptions(command))
    })
  commonBody(
    task
      .command('set <key>')
      .description('change fields on a local task')
      .option('--project <X>', 'resolve the task in this project')
      .option('--title <text>', 'replace the task title')
      .option('--status <Y>', 'replace the task status')
      .option('--parent <key>', 'replace the parent task key')
      .addOption(new PresenceOption('--no-parent', 'clear the parent task'))
      .option('--assignee <name>', 'replace the task assignee')
      .option('--force', 'allow replacing an existing task body')
      .option('--abandon <reason>', 'record why unlanded work may be abandoned'),
  ).action(async (key, _options, command) => {
    open()
    const options = taskOptions(command)
    if (options.parent !== undefined && options.noParent)
      throw new Error('--parent and --no-parent are mutually exclusive')
    const body = taskBody(options)
    const changes = {
      ...(options.title !== undefined ? { title: required(options, 'title') } : {}),
      ...(options.status !== undefined ? { status: required(options, 'status') } : {}),
      ...(options.parent !== undefined
        ? { parent: required(options, 'parent') }
        : options.noParent
          ? { parent: null }
          : {}),
      ...(body !== undefined ? { body } : {}),
      ...(options.assignee !== undefined ? { assignee: required(options, 'assignee') } : {}),
    }
    if (!Object.keys(changes).length)
      throw new Error(`${PLATFORM_SLUG} task set requires a field to change`)
    printTaskRow(
      await setTask(key, { project: options.project }, changes, await cliAttribution(), {
        force: Boolean(options.force),
        abandonReason: optional(options, 'abandon'),
      }),
    )
  })
}

function registerTaskLifecycleCommands(task: Command): void {
  task
    .command('close <key>')
    .description('close a task, release its claims, and prune its branches')
    .option('--project <X>', 'resolve the task in this project')
    .option('--keep-branches', 'leave the task branches unpruned')
    .option('--abandon <reason>', 'record why unlanded work may be abandoned')
    .action(async (key, _options, command) => {
      open()
      await closeTask(key, taskOptions(command))
    })
  task
    .command('comment <key> <text>')
    .description('add a comment to a task')
    .option('--project <X>', 'resolve the task in this project')
    .action(async (key, text, _options, command) => {
      open()
      const comment = await commentTask(
        key,
        { project: taskOptions(command).project },
        text,
        await cliAttribution(),
      )
      console.log(`${comment.task_key} commented ${comment.created_at}`)
    })
  task
    .command('comment-edit <key> <comment-id> <text>')
    .description('edit one of your task comments')
    .option('--project <X>', 'resolve the task in this project')
    .action(async (key, commentId, text, _options, command) => {
      open()
      const edited = await editTaskComment(
        key,
        { project: taskOptions(command).project },
        commentId,
        text,
        await cliAttribution(),
      )
      console.log(`${edited.task_key} comment ${edited.id} edited ${edited.updated_at}`)
    })
  task
    .command('comment-delete <key> <comment-id>')
    .description('delete one of your task comments')
    .option('--project <X>', 'resolve the task in this project')
    .action(async (key, commentId, _options, command) => {
      open()
      await deleteTaskComment(
        key,
        { project: taskOptions(command).project },
        commentId,
        await cliAttribution(),
      )
      console.log(`${key.toUpperCase()} comment ${commentId} deleted`)
    })
  task
    .command('import <file>')
    .description('backfill from a clustered commit history')
    .action(async (file) => {
      open()
      console.log(`imported ${await importTasks(file)} tasks`)
    })
  task
    .command('push')
    .description('audit hosted identity sets; --repair queues missing machine rows')
    .option('--repair', 'queue machine task rows missing from the hosted record')
    .option('--json', 'write the audit report as JSON')
    .action(async (_options, command) => {
      open()
      await runHostedTaskMaintenance('push', taskOptions(command))
    })
  task
    .command('prune-foreign')
    .description('soft-delete foreign tasks from the active hosted space')
    .option('--dry-run', 'list candidates without deleting them')
    .option('--confirm <N>', 'confirm the exact candidate count')
    .option('--project <name>', 'limit candidates to this project')
    .option('--only-present-elsewhere', 'limit candidates to tasks found in their target space')
    .option('--json', 'write the result as JSON')
    .action(async (_options, command) => {
      await runHostedTaskMaintenance('prune-foreign', taskOptions(command))
    })
}

function registerTaskDocumentReadCommands(document: Command): void {
  commonBody(
    document
      .command('new <key>')
      .description('create a document attached to a task')
      .option('--project <X>', 'resolve the task in this project')
      .option('--title <text>', 'set the document title')
      .option('--role <role>', 'assign this document role'),
  ).action(async (key, _options, command) => {
    open()
    const options = taskOptions(command)
    const created = await createTaskDocument(
      {
        task: key,
        title: required(options, 'title'),
        body: taskBody(options),
        role: options.role,
      },
      { project: options.project },
    )
    console.log(created.label)
  })
  document
    .command('list <key>')
    .description('list documents attached to a task')
    .option('--project <X>', 'resolve the task in this project')
    .option('--json', 'write the document summaries as JSON')
    .action((key, _options, command) => {
      open()
      const options = taskOptions(command)
      const documents = listTaskDocuments(key, { project: options.project })
      if (options.json) console.log(JSON.stringify(documents))
      else if (!documents.length) console.log('no documents')
      else
        for (const item of documents)
          console.log(`${item.label}${item.role ? ` [${item.role}]` : ''}  ${item.title}`)
    })
  document
    .command('show <reference>')
    .description('show a task document')
    .option('--project <X>', 'resolve the document in this project')
    .option('--json', 'write the document as JSON')
    .action((reference, _options, command) => {
      open()
      const options = taskOptions(command)
      const item = getTaskDocument(reference, { project: options.project })
      if (options.json) console.log(JSON.stringify(item))
      else {
        console.log(
          `${item.label}  ${item.task_key}${item.role ? ` [${item.role}]` : ''}  ${item.title}`,
        )
        console.log(`version: ${item.version}`)
        if (item.body) console.log(`\n${item.body}`)
      }
    })
}

function registerTaskDocumentWriteCommands(document: Command): void {
  commonBody(
    document
      .command('set <reference>')
      .description('change fields on a task document')
      .option('--project <X>', 'resolve the document in this project')
      .option('--title <text>', 'replace the document title')
      .option('--role <role>', 'replace the document role')
      .addOption(new PresenceOption('--no-role', 'clear the document role'))
      .option('--version <token>', 'require this current document version'),
  ).action(async (reference, _options, command) => {
    open()
    const options = taskOptions(command)
    if (options.role !== undefined && options.noRole)
      throw new Error('--role and --no-role are mutually exclusive')
    const body = taskBody(options)
    const changes = {
      ...(options.title !== undefined ? { title: required(options, 'title') } : {}),
      ...(options.role !== undefined
        ? { role: required(options, 'role') }
        : options.noRole
          ? { role: null }
          : {}),
      ...(body !== undefined ? { body } : {}),
      ...(options.version !== undefined ? { expectedVersion: required(options, 'version') } : {}),
    }
    if (!Object.keys(changes).length)
      throw new Error(`${PLATFORM_SLUG} task doc set requires a field to change`)
    const updated = await updateTaskDocument(reference, changes, {
      scope: { project: options.project },
    })
    console.log(`${updated.label} updated; version ${updated.version}`)
  })
  document
    .command('rm <reference>')
    .description('remove a task document')
    .option('--project <X>', 'resolve the document in this project')
    .action(async (reference, _options, command) => {
      open()
      const options = taskOptions(command)
      const removed = await deleteTaskDocument(reference, {
        scope: { project: options.project },
      })
      console.log(`${removed.label} removed from ${removed.task_key}`)
    })
}

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('manage tasks and their documents')
  registerTaskCreationCommands(task)
  registerTaskQueryCommands(task)
  registerTaskLifecycleCommands(task)
  const document = task
    .command('doc')
    .description('manage documents attached to tasks')
    .alias('document')
  registerTaskDocumentReadCommands(document)
  registerTaskDocumentWriteCommands(document)
}
