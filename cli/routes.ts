type RouteOwner = 'orch' | 'hub' | 'local' | 'composite' | 'outbox'

export type CommandRoute = {
  command: readonly string[]
  owner: RouteOwner
  argv?: readonly string[]
  composite?: readonly {
    owner: 'orch' | 'hub'
    argv: readonly string[]
    label: string
    options?: Readonly<Record<string, boolean>>
  }[]
  continueOnFailure?: boolean
  description?: string
  options?: readonly {
    flags: string
    description: string
  }[]
  hidden?: boolean
}

export const GROUPS = [
  ['run', 'dispatch and inspect runs'],
  ['session', 'architect session lifecycle'],
  ['question', 'open worker questions and rulings'],
  ['score', 'verdicts on runs'],
  ['review', 'review runs, lenses, tiers, and confinement'],
  ['workflow', 'workflows and their cursors'],
  ['task', 'tasks and task documents'],
  ['note', 'observations and their lifecycle'],
  ['report', 'reports'],
  ['board', "the architects' board"],
  ['doc', 'documents, canon, code search, and ports'],
  ['project', 'the project register'],
  ['tree', 'worktrees and branches'],
  ['pr', 'pull requests'],
  ['gate', 'gates and mechanical checks'],
  ['release', 'releases and rungs'],
  ['record', 'the hosted record and outbox'],
  ['agent', 'agents, jobs, and routing'],
  ['dashboard', 'the local dashboard'],
  ['machine', 'upkeep of this machine'],
  ['mcp', 'model-context-protocol services'],
] as const

const route = (
  command: string,
  owner: 'orch' | 'hub',
  argv: string,
  description?: string,
): CommandRoute => ({
  command: command.split(' '),
  owner,
  argv: argv.split(' '),
  ...(description === undefined ? {} : { description }),
})

export const ROUTES = (
  [
    route('run start', 'orch', 'do'),
    route('run show', 'orch', 'run'),
    route('run list', 'orch', 'runs'),
    route('run identity-map', 'orch', 'run-identities'),
    route('run link-tasks', 'orch', 'link-tasks'),
    route('question identity-map', 'orch', 'question-identities'),
    ...[
      'diff',
      'state',
      'search',
      'tell',
      'relay',
      'waiting',
      'peek',
      'result',
      'finish',
      'wait',
      'retry',
      'continue',
      'stop',
      'abandon',
      'discard',
      'close-out',
      'spawns',
      'reconcile',
    ].map((name) => route(`run ${name}`, 'orch', name)),
    route('question inbox', 'orch', 'inbox'),
    route('question answer', 'orch', 'answer'),
    route('question close', 'orch', 'question close'),
    route('question ruling', 'orch', 'ruling'),
    route('question stats', 'hub', 'rulings'),
    route('score recalibrate', 'orch', 'recalibrate'),
    route('score pending', 'orch', 'pending'),
    route('score', 'orch', 'score'),
    route('review lens', 'orch', 'lens'),
    route('review confinement', 'orch', 'confinement'),
    route('review', 'orch', 'review'),
    route(
      'workflow fix-defect',
      'orch',
      'fix-defect',
      'dispatch filed defect issues or list those waiting',
    ),
    route('workflow epic', 'orch', 'epic', 'show the scoreboard for an epic and its child tasks'),
    route('workflow', 'orch', 'workflow'),
    route('task recent', 'hub', 'tasks'),
    route('task', 'hub', 'task'),
    route('note new', 'hub', 'note new'),
    route('note', 'hub', 'note'),
    route('report', 'hub', 'report'),
    route('board', 'orch', 'board'),
    route('doc subject', 'orch', 'subject'),
    route('doc canon', 'orch', 'canon'),
    route('doc code', 'orch', 'code'),
    route('doc port', 'orch', 'port'),
    route(
      'doc reference publish',
      'orch',
      'reference publish',
      'publish the generated command reference',
    ),
    route('doc', 'orch', 'doc'),
    route('project', 'orch', 'project'),
    route('session', 'orch', 'session'),
    route('tree branch', 'orch', 'branches'),
    route('tree', 'orch', 'tree'),
    route('pr', 'orch', 'pr'),
    route('gate check', 'orch', 'check'),
    route('gate ratchet', 'orch', 'ratchet'),
    route('gate enforcement', 'orch', 'enforcement'),
    route('gate test-substance', 'orch', 'test-substance'),
    route('gate hub-import', 'orch', 'hub-import'),
    route('gate', 'orch', 'gate'),
    route('release run', 'orch', 'release'),
    route(
      'release check',
      'orch',
      'release check',
      'validate the reported version before tagging a release',
    ),
    route('release log', 'orch', 'release log'),
    {
      command: ['record', 'sync'],
      owner: 'composite',
      description: 'synchronize both concern records',
      composite: [
        {
          owner: 'orch',
          argv: ['sync'],
          label: 'orchestrator sync',
          options: { '--backfill': false },
        },
        {
          owner: 'hub',
          argv: ['collect'],
          label: 'hub collection',
          options: { '--since': true, '--only': true },
        },
      ],
    },
    route('record pull', 'hub', 'collect', 'ingest every source into the local record'),
    route('record lease', 'hub', 'lease', 'show the current local collect lease'),
    route('record push', 'orch', 'sync', "push this machine's orchestrator record"),
    route(
      'record outbox trace',
      'hub',
      'outbox trace',
      'list non-trivial delivery outcomes, newest first',
    ),
    {
      command: ['record', 'outbox'],
      owner: 'outbox',
      description: 'inspect and retry pending record writes',
      options: [{ flags: '--json', description: 'print entries as JSON' }],
    },
    route('record', 'orch', 'record'),
    route('agent show', 'orch', 'agent show'),
    route('agent add', 'orch', 'agent add'),
    route('agent set', 'orch', 'agent set'),
    route('agent remove', 'orch', 'agent remove'),
    route('agent list', 'orch', 'agents'),
    route(
      'agent probe',
      'orch',
      'agent probe',
      'prove registration capabilities and clear a quota cooldown on success',
    ),
    ...[
      'context',
      'contract',
      'guide',
      'stats',
      'routing-backtest',
      'cost-backtest',
      'metric',
      'pick',
      'jobs',
    ].map((name) => route(`agent ${name}`, 'orch', name)),
    route('dashboard start', 'hub', 'serve', 'start the local dashboard'),
    route(
      'dashboard check',
      'hub',
      'serve-check',
      'confirm this checkout dashboard is not serving',
    ),
    route('dashboard stop', 'hub', 'serve-stop', 'stop this checkout dashboard'),
    route('dashboard login', 'hub', 'login', 'print a one-time local dashboard login URL'),
    {
      command: ['machine', 'doctor'],
      owner: 'composite',
      description: 'inspect orchestrator and hub health',
      composite: [
        {
          owner: 'orch',
          argv: ['doctor'],
          label: 'orchestrator doctor',
          options: { '--wake': false },
        },
        { owner: 'hub', argv: ['doctor'], label: 'hub health' },
      ],
      continueOnFailure: true,
    },
    {
      command: ['machine', 'migrate'],
      owner: 'composite',
      description: 'migrate the orchestrator and hub stores',
      composite: [
        {
          owner: 'orch',
          argv: ['migrate'],
          label: 'orchestrator migrate',
          options: {
            '--backfill-spec-sha': false,
            '--force-in-flight': true,
            '--from-operator': false,
          },
        },
        { owner: 'hub', argv: ['migrate'], label: 'hub migration' },
      ],
    },
    route('machine update', 'orch', 'update', 'update the main checkout after draining runs'),
    route('machine gate-facts', 'orch', 'gate-facts', 'write branch-stable gate facts'),
    route('machine reconcile', 'hub', 'reconcile'),
    ...[
      'health',
      'blockers',
      'monitor',
      'load',
      'storage',
      'provisioning',
      'efficiency',
      'sweep',
      'reclaim',
      'rename',
      'retire',
      'config',
      'settings',
      'setup',
      'setup-ask',
      'reclassify-failures',
      'spare',
    ].map((name) => route(`machine ${name}`, 'orch', name)),
    route('machine reclaim-fixture-questions', 'hub', 'reclaim-fixture-questions'),
    { command: ['machine', 'init-db'], owner: 'orch', argv: ['init-db'], hidden: true },
    {
      command: ['machine', 'legacy-calls'],
      owner: 'local',
      description: 'report legacy orchestrator and hub invocations',
      options: [
        {
          flags: '--since <timestamp>',
          description: 'include calls at or after this ISO timestamp',
        },
        { flags: '--json', description: 'print the report as JSON' },
      ],
    },
    route('mcp serve', 'orch', 'mcp'),
    route('mcp ask-server', 'orch', 'ask-server'),
    { command: ['mcp', 'reader-proxy'], owner: 'orch', argv: ['mcp-reader-proxy'], hidden: true },
  ] satisfies CommandRoute[]
).sort((left, right) => right.command.length - left.command.length)

export function resolveRoute(
  argv: readonly string[],
): { route: CommandRoute; rest: string[] } | null {
  for (const candidate of ROUTES) {
    if (candidate.command.every((part, index) => argv[index] === part)) {
      return { route: candidate, rest: argv.slice(candidate.command.length) }
    }
  }
  return null
}
