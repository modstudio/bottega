// concern: cli
/** Registers documentation and register adapters. Must not own their behavior. */
import { type Command, Option } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { canonLintCommand, dispatchCanonCommand } from '../canon/canon-commands.ts'
import { collectCanonLintInput } from '../canon/canon-files.ts'
import { docCommand } from '../doc/doc-commands.ts'
import { selectDocWriteTree } from '../doc/doc-write-tree.ts'
import { portCommand } from '../porting/port-commands.ts'
import { projectCommand } from '../project/project-commands.ts'
import { requireRecordSpaceMembership } from '../record/record-space.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'
import { resumeBriefHandoff } from '../session/resume-brief-handoff.ts'
import { actionCommand, collect, log, optionFlags, values, write, writeStdout } from './support.ts'

type Flags = { has(name: string): boolean }
type Opt = readonly [flags: string, description: string, collect?: true]
type Spec = readonly [syntax: string, description: string, options: readonly Opt[]]

class PresenceOption extends Option {
  constructor(flags: string, description: string) {
    super(flags, description)
    this.negate = false
  }
}

const descriptions: Record<string, string> = {
  scope: 'select the document scope',
  subject: 'select the document subject',
  user: 'address the signed-in user document',
  title: 'set the title',
  file: 'read the body from a file',
  reason: 'record the reason for the change',
  author: 'record the revision author',
  delivery: 'set demand or inject delivery',
  audience: 'filter or set document audiences',
  match: 'match document titles or slugs',
  'body-match': 'match document body text',
  parent: 'set the parent article slug',
  'parent-id': 'select the parent document id',
  id: 'add a document id to the sibling order',
  'no-parent': 'clear the parent article slug',
  form: 'set the article form',
  'no-form': 'clear the article form',
  'article-subject': 'filter or set the article subject',
  'no-article-subject': 'clear the article subject',
  'related-subject': 'add a related subject name or id',
  'no-related-subjects': 'clear all related subjects',
  'source-file': 'add a repository-relative source path',
  'no-source-files': 'clear all source files',
  'checked-at': 'set the commit checked by this article',
  'no-checked-at': 'clear the checked commit',
  summary: 'set the written summary',
  'no-summary': 'clear the written summary',
  position: 'set the article position',
  featured: 'mark the article as featured',
  'no-featured': 'mark the article as not featured',
  status: 'filter or set document status',
  kind: 'filter or set document kind',
  replacement: 'name the replacement document',
  'include-drafts': 'include draft documents',
  'force-inject': 'give the reason for overriding inject policy',
  expect: 'require the current revision',
  cwd: 'use this working directory',
  k: 'limit semantic search results',
  json: 'print JSON output',
  job: 'compile canon for this job',
  slug: 'select a canon evaluation',
  agent: 'select an agent',
  project: 'select a project',
  baseline: 'use this canon lint baseline',
  accept: 'accept the current pack difference',
  all: 'include all rows',
  force: 'rerun completed evaluations',
  strict: 'fail when canon lint findings remain',
  'write-baseline': 'write the canon lint baseline',
  check: 'check without applying changes',
  harness: 'select a harness',
  role: 'select architect or worker loading',
  'dry-run': 'show changes without applying them',
  adopt: 'adopt hydrated user canon',
  sources: 'provide source provenance as JSON',
  note: 'record the provenance note',
  clear: 'clear the stored value',
  replace: 'replace conflicting imported values',
  name: 'set the project or profile name',
  stack: 'set the project stack',
  space: 'select a record space by id or slug',
  settings: 'set project settings from JSON',
  path: 'set the project checkout path',
  axis: 'select a routing profile axis',
  lens: 'select one review lens',
  version: 'select a profile version',
  'no-canon': 'disable canon for the project',
  canon: 'enable canon for the project',
  'allow-incomplete': 'allow incomplete worktree settings',
  apply: 'apply the proposed migration',
  retired: 'include retired projects',
  undo: 'reverse project retirement',
}

const key = (flags: string) => flags.match(/^--([^ <]+)/)?.[1] ?? flags
const o = (flags: string, collect?: true): Opt => [flags, descriptions[key(flags)]!, collect]
function options(command: Command, specs: readonly Opt[]): Command {
  for (const [flags, description, repeated] of specs) {
    if (flags.startsWith('--no-') && !['--no-featured', '--no-canon'].includes(flags))
      command.addOption(new PresenceOption(flags, description))
    else if (repeated) command.option(flags, description, collect, [])
    else command.option(flags, description)
  }
  return command
}

const json = [o('--json')]
const address = [o('--scope <value>'), o('--subject <value>'), o('--user')]
const revision = [o('--reason <value>'), o('--author <value>'), o('--expect <revision>')]

export function assertUserCanonHydrateAllowed(
  flags: Flags,
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
  inventory?: ProcessInventory,
): void {
  if (!isOrchWorkerProcess(env, pid, inventory)) return
  if (flags.has('check') && !flags.has('adopt')) return
  const command = `${PLATFORM_SLUG} doc canon hydrate --user${flags.has('adopt') ? ' --adopt' : ''}`
  throw new Error(
    `refusing user canon hydrate from an orchestrator worker run; an operator must run ${command}`,
  )
}

async function runDoc(verb: string, args: string[], command: Command): Promise<void> {
  await docCommand(
    verb,
    ['doc', verb, ...args],
    optionFlags(command.opts()),
    {
      log,
      error: console.error,
      write,
      stdinText: () => Bun.stdin.text(),
      stdinIsTTY: process.stdin.isTTY,
      cwd: process.cwd,
      exitCode: (code) => {
        process.exitCode = code
      },
    },
    {
      selectDocWriteTree,
      collectCanonLintInput,
      consumeResumeHandoff: resumeBriefHandoff,
    },
  )
}

const docSpecs: readonly Spec[] = [
  [
    'list',
    'list document metadata and bodies',
    [
      ...address,
      o('--audience <value>'),
      o('--status <value>'),
      o('--kind <value>'),
      o('--article-subject <value>'),
      o('--match <value>'),
      o('--body-match <value>'),
      ...json,
    ],
  ],
  [
    'show [slug]',
    'show a document with its metadata',
    [...address, o('--audience <value>'), ...json],
  ],
  [
    'get [slug]',
    'get a document with its metadata',
    [...address, o('--audience <value>'), ...json],
  ],
  [
    'search [query]',
    'search documents semantically',
    [...address, o('--include-drafts'), o('--k <value>'), ...json],
  ],
  ['lint', 'lint stored documents', [...address, ...json]],
  ['warnings', 'show stored document warnings', [...address, ...json]],
  [
    'set [slug]',
    'create or revise a document',
    [
      ...address,
      o('--cwd <value>'),
      o('--title <value>'),
      o('--file <value>'),
      ...revision,
      o('--delivery <value>'),
      o('--audience <value>'),
      o('--parent <slug>'),
      o('--no-parent'),
      o('--position <value>'),
      o('--featured'),
      o('--no-featured'),
      o('--status <value>'),
      o('--kind <value>'),
      o('--replacement <slug>'),
      o('--form <value>'),
      o('--no-form'),
      o('--article-subject <value>'),
      o('--no-article-subject'),
      o('--related-subject <value>', true),
      o('--no-related-subjects'),
      o('--source-file <value>', true),
      o('--no-source-files'),
      o('--checked-at <commit>'),
      o('--no-checked-at'),
      o('--summary <text>'),
      o('--no-summary'),
      o('--force-inject <value>'),
      ...json,
    ],
  ],
  [
    'status [slug]',
    'change a document status',
    [...address, ...revision, o('--status <value>'), o('--replacement <slug>'), ...json],
  ],
  [
    'reorder',
    'replace one document sibling order',
    [...address, o('--parent <value>'), o('--slug <value>', true), ...json],
  ],
  [
    'consume [slug]',
    "mark a resume brief consumed and hand its author's runs to the consuming session",
    [...address, ...revision, ...json],
  ],
  ['rm [slug]', 'remove a document', [...address, o('--cwd <value>'), ...revision, ...json]],
  ['subjects', 'list document subjects', json],
  ['export [dir]', 'export documents to a directory', []],
  [
    'import [dir]',
    'import documents from a directory',
    [o('--reason <value>'), o('--author <value>')],
  ],
  ['history [scope] [subject] [slug]', 'list document revision history', [o('--user'), ...json]],
  [
    'revision [scope] [subject] [slug] [revision]',
    'show one document revision',
    [o('--user'), o('--audience <value>'), ...json],
  ],
  ['diff [scope] [subject] [slug] [from] [to]', 'diff two document revisions', [o('--user')]],
  [
    'restore [scope] [subject] [slug] [revision]',
    'restore a document revision',
    [o('--user'), ...revision, ...json],
  ],
  ['resumes', 'list open resume briefs', [o('--cwd <value>'), ...json]],
]

function registerDoc(program: Command): void {
  const family = program
    .command('doc')
    .description('manage operator documents')
    .allowExcessArguments(true)
    .action((...input: unknown[]) => {
      const command = actionCommand(input)
      const [verb = 'list', ...args] = command.args
      return runDoc(verb, args, command)
    })
  for (const [syntax, description, opts] of docSpecs) {
    const verb = syntax.split(' ')[0]!
    options(family.command(syntax).description(description), opts).action((...args: unknown[]) =>
      runDoc(verb, values(args.slice(0, -1)), actionCommand(args)),
    )
  }
}

const canonSpecs: readonly Spec[] = [
  ['audit', 'audit repository canon and observations', [o('--dry-run'), ...json]],
  ['mirror', 'mirror repository canon into projects', [o('--project <value>'), o('--dry-run')]],
  [
    'import',
    'import rendered canon into the store',
    [
      o('--project <value>'),
      o('--cwd <value>'),
      o('--reason <value>'),
      o('--user'),
      o('--dry-run'),
    ],
  ],
  [
    'hydrate',
    'hydrate stored canon into a working tree',
    [
      o('--project <value>'),
      o('--cwd <value>'),
      o('--user'),
      o('--check'),
      o('--dry-run'),
      o('--adopt'),
    ],
  ],
  ['list', 'list stored repository canon', [o('--project <value>'), o('--user'), ...json]],
  [
    'check',
    'check the compiled canon pack',
    [o('--cwd <value>'), o('--job <value>'), o('--all'), ...json],
  ],
  [
    'diff',
    'show or accept a canon pack difference',
    [o('--cwd <value>'), o('--job <value>'), o('--accept'), ...json],
  ],
  [
    'eval',
    'run canon evaluations',
    [
      o('--cwd <value>'),
      o('--slug <value>'),
      o('--agent <value>'),
      o('--project <value>'),
      o('--force'),
      ...json,
    ],
  ],
  ['evals', 'show canon evaluation results', json],
  [
    'lint',
    'lint canon files and budgets',
    [
      o('--cwd <value>'),
      o('--project <value>'),
      o('--baseline <value>'),
      o('--strict'),
      o('--write-baseline'),
      ...json,
    ],
  ],
  [
    'load',
    'show canon loaded by each harness',
    [
      o('--cwd <value>'),
      o('--harness <value>'),
      o('--role <value>'),
      o('--agent <value>'),
      ...json,
    ],
  ],
]

async function runCanon(verb: string, command: Command): Promise<void> {
  const flags = optionFlags(command.opts())
  if (verb === 'hydrate' && flags.has('user')) assertUserCanonHydrateAllowed(flags)
  await import('../jobs/jobs.ts')
  const presentation = {
    log,
    exitCode: (code: number) => {
      process.exitCode = code
    },
    cwd: process.cwd,
  }
  if (verb === 'lint') canonLintCommand(flags, presentation)
  else await dispatchCanonCommand(['canon', verb], flags, presentation)
}

function registerCanon(program: Command): void {
  const family = program
    .command('canon')
    .description('inspect, validate, and hydrate canon')
    .allowExcessArguments(true)
    .action((...input: unknown[]) => {
      const command = actionCommand(input)
      return runCanon(command.args[0] ?? '', command)
    })
  for (const [syntax, description, opts] of canonSpecs)
    options(family.command(syntax).description(description), opts).action((...input: unknown[]) =>
      runCanon(syntax, actionCommand(input)),
    )
}

const portSpecs: readonly Spec[] = [
  ['import [dir]', 'import a port ledger directory', [o('--dry-run'), o('--replace'), ...json]],
  ['baseline show [source] [target]', 'show a project-pair baseline', json],
  [
    'baseline set [source] [target] [commit]',
    'set or clear a project-pair baseline',
    [o('--clear'), ...json],
  ],
  ['skip list [source] [target]', 'list skipped candidates', json],
  [
    'skip add [source] [target] [candidate]',
    'record a skipped candidate',
    [o('--reason <value>'), ...json],
  ],
  ['ref list', 'list port ledger references', [o('--all'), ...json]],
  ['ref show [task-key]', 'show a port ledger reference', [o('--project <value>'), ...json]],
  [
    'ref set [task-key]',
    'record task port provenance',
    [o('--project <value>'), o('--sources <value>'), o('--note <value>'), ...json],
  ],
  ['ref resolve [task-key]', 'mark a port reference resolved', [o('--project <value>'), ...json]],
  [
    'ref delete-error [task-key]',
    'delete an erroneous port reference',
    [o('--project <value>'), ...json],
  ],
  ['doctrine list', 'list porting doctrine', [o('--all'), ...json]],
  [
    'doctrine add [number]',
    'add a porting doctrine rule',
    [o('--title <value>'), o('--file <value>'), ...json],
  ],
  ['doctrine retire [number]', 'retire a porting doctrine rule', json],
]

async function runPort(path: string[], args: string[], command: Command): Promise<void> {
  await portCommand(path[0], path[1], ['port', ...path, ...args], optionFlags(command.opts()), {
    log,
    writeStdout,
    exitCode: (code) => {
      process.exitCode = code
    },
  })
}

function registerPort(program: Command): void {
  const family = program
    .command('port')
    .description('manage porting provenance and doctrine')
    .allowExcessArguments(true)
    .action((...input: unknown[]) => {
      const command = actionCommand(input)
      return runPort(command.args.slice(0, 2), command.args.slice(2), command)
    })
  const parents = new Map<string, Command>()
  for (const name of ['baseline', 'skip', 'ref', 'doctrine'])
    parents.set(
      name,
      family
        .command(name)
        .description(`manage port ${name} records`)
        .allowExcessArguments(true)
        .action((...input: unknown[]) => {
          const command = actionCommand(input)
          return runPort([name, ...command.args.slice(0, 1)], command.args.slice(1), command)
        }),
    )
  for (const [syntax, description, opts] of portSpecs) {
    const parts = syntax.split(' '),
      parent = parents.get(parts[0]!),
      owner = parent ?? family
    const leaf = parent ? parts.slice(1).join(' ') : syntax,
      path = parent ? [parts[0]!, parts[1]!] : [parts[0]!]
    options(owner.command(leaf).description(description), opts).action((...args: unknown[]) =>
      runPort(path, values(args.slice(0, -1)), actionCommand(args)),
    )
  }
}

const projectSpecs: readonly Spec[] = [
  ['list', 'list registered projects', [o('--retired'), ...json]],
  [
    'add [path]',
    'register a project',
    [
      o('--name <value>'),
      o('--stack <value>'),
      o('--space <value>'),
      o('--settings <value>'),
      o('--no-canon'),
      o('--allow-incomplete'),
      ...json,
    ],
  ],
  [
    'set [name]',
    'update a registered project',
    [
      o('--name <value>'),
      o('--stack <value>'),
      [
        '--settings <value>',
        'apply a JSON Merge Patch: objects merge; arrays and values replace; null removes a key; omitted keys are kept',
      ],
      o('--path <value>'),
      o('--canon'),
      o('--no-canon'),
      o('--allow-incomplete'),
      ...json,
    ],
  ],
  [
    'select-profile [project]',
    'select a project routing profile',
    [
      o('--axis <value>'),
      o('--name <value>'),
      o('--lens <value>'),
      o('--version <value>'),
      o('--reason <value>'),
      ...json,
    ],
  ],
  ['migrate-create [name]', 'migrate a legacy create command', [o('--apply')]],
  ['remove [name]', 'remove a project from the register', []],
  ['retire [name]', 'retire or un-retire a project', [o('--undo')]],
  ['push', 'push projects to the hosted record', json],
  ['fill-record-ids', 'fill missing hosted project identities', json],
]

async function runProject(verb: string, args: string[], command: Command): Promise<void> {
  await projectCommand(
    verb,
    ['project', verb, ...args],
    optionFlags(command.opts()),
    { log, cwd: process.cwd },
    { requireSpaceMembership: requireRecordSpaceMembership },
  )
}

function registerProject(program: Command): void {
  const family = program
    .command('project')
    .description('manage the project register')
    .allowExcessArguments(true)
    .action((...input: unknown[]) => {
      const command = actionCommand(input)
      const [verb = 'list', ...args] = command.args
      return runProject(verb, args, command)
    })
  for (const [syntax, description, opts] of projectSpecs) {
    const verb = syntax.split(' ')[0]!
    options(family.command(syntax).description(description), opts).action((...args: unknown[]) =>
      runProject(verb, values(args.slice(0, -1)), actionCommand(args)),
    )
  }
}

export function register(program: Command): void {
  registerDoc(program)
  registerCanon(program)
  registerPort(program)
  registerProject(program)
}
