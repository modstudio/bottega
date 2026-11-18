import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_SHAPES } from '../../../shared/record-shape.ts'
import { program, run } from '../cli/program.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'

const stepsFolder = resolve(import.meta.dir, '../../../.agents/workflow-steps')
const database = testDatabaseFixture(seedWorkflows)
const closeCommand = `${PLATFORM_SLUG} workflow next`

type ActionCommand = Command & { _actionHandler?: (...args: unknown[]) => unknown }

function workflowNextCommands(body: string): string[] {
  const commands = new Set<string>()
  for (const match of body.matchAll(/`([^`\n]*)`/g))
    if (match[1]!.includes(closeCommand)) commands.add(match[1]!)
  for (const fence of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const normalized = fence[1]!.replace(/\\\r?\n/g, ' ')
    for (const line of normalized.split(/\r?\n/)) {
      const start = line.indexOf(closeCommand)
      if (start >= 0) commands.add(line.slice(start))
    }
  }
  return [...commands]
}

function renderedTokens(command: string): string[] {
  const rendered = command.replace(/<[^>]+>|\{\{[^}]+\}\}/g, 'fixture')
  return [...rendered.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  )
}

async function grammarFailures(command: string): Promise<string[]> {
  const tokens = renderedTokens(command)
  const start = tokens.findIndex(
    (token, index) => token === 'workflow' && tokens[index + 1] === 'next',
  )
  if (start < 0) return [`does not contain the workflow next command: ${command}`]
  const workflow = program.commands.find((entry) => entry.name() === 'workflow')!
  const next = workflow.commands.find((entry) => entry.name() === 'next') as ActionCommand
  const originalAction = next._actionHandler
  const originalOutput = next.configureOutput()
  const errors: string[] = []
  next._actionHandler = () => undefined
  next.configureOutput({ ...originalOutput, writeErr: (value) => errors.push(value) })
  process.exitCode = undefined
  try {
    const code = await run(tokens.slice(start))
    return code === 0 ? [] : [errors.join('').trim() || `parser exited ${code}`]
  } finally {
    next._actionHandler = originalAction
    next.configureOutput(originalOutput)
    process.exitCode = undefined
  }
}

function literalNoteFailure(command: string): string | null {
  const rawTokens = renderedTokens(command)
  const note = rawTokens[rawTokens.indexOf('--note') + 1]
  if (!note || command.match(/--note\s+(?:<|\{\{)/)) return null
  return note.length > RECORD_SHAPES['step note'].maxChars
    ? `literal --note is ${note.length} characters; limit ${RECORD_SHAPES['step note'].maxChars}`
    : null
}

function outcomeFailure(command: string, declared: string[] | undefined): string | null {
  if (!declared?.length) return null
  const tokens = renderedTokens(command)
  const value = tokens[tokens.indexOf('--outcome') + 1]
  return !value || !declared.includes(value)
    ? `--outcome must be one of ${declared.join(', ')}`
    : null
}

async function productionCommandFailures(): Promise<string[]> {
  const outcomes = new Map(
    productionStepCatalogue(database()).definition.steps.map((step) => [step.slug, step.outcomes]),
  )
  const failures: string[] = []
  for (const file of readdirSync(stepsFolder)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    const slug = basename(file, '.md')
    for (const command of workflowNextCommands(readFileSync(join(stepsFolder, file), 'utf8'))) {
      for (const failure of await grammarFailures(command)) failures.push(`${file}: ${failure}`)
      const outcome = outcomeFailure(command, outcomes.get(slug))
      if (outcome) failures.push(`${file}: ${outcome}`)
      const noteFailure = literalNoteFailure(command)
      if (noteFailure) failures.push(`${file}: ${noteFailure}`)
    }
  }
  return failures
}

test('production workflow step close commands match the real workflow next grammar', async () => {
  expect(await productionCommandFailures()).toEqual([])
})

test('the step close-command guard accepts repeated artifacts', async () => {
  expect(
    await grammarFailures(
      `${PLATFORM_SLUG} workflow next fixture --artifact exec:1 --artifact exec:2`,
    ),
  ).toEqual([])
})

test('the step close-command guard reports an unknown flag', async () => {
  const failures = await grammarFailures(`${PLATFORM_SLUG} workflow next fixture --unknown fixture`)
  expect(failures).toHaveLength(1)
  expect(failures[0]).toContain("unknown option '--unknown'")
})
