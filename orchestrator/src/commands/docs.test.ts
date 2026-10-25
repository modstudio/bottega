import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command, CommanderError } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assertUserCanonHydrateAllowed, register } from './docs.ts'
import { register as registerSubjects } from './subjects.ts'
import { drainStdout } from './support.ts'

const flags = (...names: string[]) => ({ has: (name: string) => names.includes(name) })

test('an orchestrator worker cannot hydrate user canon but can check it', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      { pid: 300, ppid: 200, pgid: 100, command: `${PLATFORM_SLUG} doc canon hydrate --user` },
    ],
  }

  expect(() => assertUserCanonHydrateAllowed(flags(), {}, 300, inventory)).toThrow(
    `refusing user canon hydrate from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} doc canon hydrate --user`,
  )
  expect(() => assertUserCanonHydrateAllowed(flags('check'), {}, 300, inventory)).not.toThrow()
})

type CompatibilityCase = readonly [
  argv: readonly string[],
  code: number,
  firstLine: string,
  firstLinePrefix?: boolean,
]

async function runRegisteredCommand(argv: readonly string[]) {
  const stdout: string[] = []
  const originalWrite = process.stdout.write
  const originalExitCode = process.exitCode
  process.exitCode = 0
  process.stdout.write = ((value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stdout.push(String(value))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') done()
    return true
  }) as typeof process.stdout.write
  const program = new Command().enablePositionalOptions().exitOverride().allowExcessArguments(false)
  register(program)
  registerSubjects(program)
  let code = 0
  try {
    await program.parseAsync(['node', 'orch', ...argv])
  } catch (error) {
    code =
      error instanceof CommanderError
        ? error.code === 'commander.helpDisplayed' || error.code === 'commander.version'
          ? 0
          : 2
        : 1
    stdout.push(error instanceof Error ? error.message : String(error))
  } finally {
    await drainStdout()
    process.stdout.write = originalWrite
  }
  code = Number(process.exitCode || code)
  process.exitCode = originalExitCode
  return { code, firstLine: stdout.join('').split('\n')[0] ?? '' }
}

test('converted families execute leaf options and refuse options before the verb', async () => {
  expect(await runRegisteredCommand(['doc', 'list', '--scope', 'global', '--json'])).toEqual({
    code: 0,
    firstLine: '[]',
  })
  expect(await runRegisteredCommand(['canon', 'diff', '--json'])).toMatchObject({
    code: 0,
    firstLine: expect.stringContaining('"job"'),
  })
  expect(await runRegisteredCommand(['doc', '--json', 'list'])).toMatchObject({
    code: 2,
    firstLine: "error: unknown option '--json'",
  })
  expect(await runRegisteredCommand(['project', '--json', 'list'])).toMatchObject({
    code: 2,
    firstLine: "error: unknown option '--json'",
  })
})

test('registered doc reorder accepts parent and repeatable slug handles', async () => {
  const result = await runRegisteredCommand([
    'doc',
    'reorder',
    '--scope',
    'global',
    '--parent',
    '01990000-0000-7000-8000-000000001214',
    '--slug',
    'first',
    '--slug',
    'second',
  ])
  expect(result.firstLine).not.toContain('unknown option')
})

test('converted command families preserve trunk output and exit status without optional arguments', async () => {
  const originalCwd = process.cwd()
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'command-family-'))
  process.chdir(fixtureRoot)
  const fixtureCwd = process.cwd()
  const cases: CompatibilityCase[] = [
    [['doc'], 0, ''],
    [['doc', 'list'], 0, ''],
    [['doc', 'show'], 1, `${PLATFORM_SLUG} doc show <slug> --scope S [--subject X]`],
    [['doc', 'get'], 1, `${PLATFORM_SLUG} doc get <slug> --scope S [--subject X]`],
    [
      ['doc', 'search'],
      1,
      `${PLATFORM_SLUG} doc search "<query>" [--scope S] [--subject X] [--k N] [--json]`,
    ],
    [['doc', 'lint'], 0, ''],
    [['doc', 'warnings'], 1, `${PLATFORM_SLUG} doc warnings --scope S [--subject X] [--json]`],
    [
      ['doc', 'set'],
      1,
      `${PLATFORM_SLUG} doc set <slug> --scope S [--subject X] [--cwd PATH] --title T --reason TEXT [--expect REVISION] (--file F | body on stdin)`,
    ],
    [
      ['doc', 'status'],
      1,
      `${PLATFORM_SLUG} doc status <slug> --scope S [--subject X] --status STATUS [--replacement SLUG] --reason TEXT [--expect REVISION]`,
    ],
    [
      ['doc', 'reorder'],
      1,
      `${PLATFORM_SLUG} doc reorder --scope S [--subject X] [--parent SLUG|UUID] --slug SLUG|UUID...`,
    ],
    [
      ['doc', 'consume'],
      1,
      `${PLATFORM_SLUG} doc consume <slug> --scope S [--subject X] [--expect REVISION]`,
    ],
    [
      ['doc', 'rm'],
      1,
      `${PLATFORM_SLUG} doc rm <slug> --scope S [--subject X] [--cwd PATH] --reason TEXT [--expect REVISION]`,
    ],
    [['doc', 'subjects'], 0, 'project  (none)'],
    [['doc', 'export'], 1, `${PLATFORM_SLUG} doc export <dir>`],
    [['doc', 'import'], 1, `${PLATFORM_SLUG} doc import <dir>`],
    [['doc', 'history'], 1, `${PLATFORM_SLUG} doc history <scope> <subject|-> <slug>`],
    [
      ['doc', 'revision'],
      1,
      `${PLATFORM_SLUG} doc revision <scope> <subject|-> <slug> <rev> --json`,
    ],
    [['doc', 'diff'], 1, `${PLATFORM_SLUG} doc diff <scope> <subject|-> <slug>`],
    [
      ['doc', 'restore'],
      1,
      `${PLATFORM_SLUG} doc restore <scope> <subject|-> <slug> <rev> --reason TEXT`,
    ],
    [['doc', 'resumes'], 0, ''],
    [
      ['canon'],
      1,
      `unknown: ${PLATFORM_SLUG} doc canon. Try audit | mirror | import | hydrate | list | check | diff | eval | evals | lint | load`,
    ],
    [['canon', 'audit'], 0, ''],
    [['canon', 'mirror'], 0, ''],
    [['canon', 'import'], 1, '--project is required'],
    [['canon', 'hydrate'], 1, '--project is required'],
    [['canon', 'list'], 1, '--project is required'],
    [['canon', 'check'], 0, 'canon: 0 canon + 0 docs = 0/65536 bytes'],
    [['canon', 'diff'], 0, 'canon understand/_: +0 bytes'],
    [
      ['canon', 'eval'],
      1,
      'current directory is not in a registered project; pass --project <name>',
    ],
    [['canon', 'evals'], 0, ''],
    [['canon', 'lint'], 1, `git -C ${fixtureCwd} rev-parse --show-toplevel failed:`, true],
    [['canon', 'load'], 1, '--cwd is required'],
    [
      ['port'],
      1,
      `unknown: ${PLATFORM_SLUG} doc port. Try import | baseline | skip | ref | doctrine`,
    ],
    [['port', 'baseline'], 1, `unknown: ${PLATFORM_SLUG} doc port baseline. Try show | set`],
    [['port', 'skip'], 1, `unknown: ${PLATFORM_SLUG} doc port skip. Try list | add`],
    [
      ['port', 'ref'],
      1,
      `unknown: ${PLATFORM_SLUG} doc port ref. Try list | show | set | resolve | delete-error`,
    ],
    [
      ['port', 'doctrine'],
      1,
      `unknown: ${PLATFORM_SLUG} doc port doctrine. Try list | add | retire`,
    ],
    [
      ['port', 'import'],
      1,
      `${PLATFORM_SLUG} doc port import <dir> [--dry-run] [--replace] [--json]`,
    ],
    [
      ['port', 'baseline', 'show'],
      1,
      `${PLATFORM_SLUG} doc port baseline show <source> <target> [--json]`,
    ],
    [
      ['port', 'baseline', 'set'],
      1,
      `${PLATFORM_SLUG} doc port baseline set <source> <target> <commit> [--json] | --clear`,
    ],
    [['port', 'skip', 'list'], 1, `${PLATFORM_SLUG} doc port skip list <source> <target> [--json]`],
    [
      ['port', 'skip', 'add'],
      1,
      `${PLATFORM_SLUG} doc port skip add <source> <target> <candidate> --reason TEXT [--json]`,
    ],
    [['port', 'ref', 'list'], 0, ''],
    [
      ['port', 'ref', 'show'],
      1,
      `${PLATFORM_SLUG} doc port ref show <task-key> --project PROJECT [--json]`,
    ],
    [
      ['port', 'ref', 'set'],
      1,
      `${PLATFORM_SLUG} doc port ref set <task-key> --project PROJECT --sources JSON --note TEXT [--json]`,
    ],
    [
      ['port', 'ref', 'resolve'],
      1,
      `${PLATFORM_SLUG} doc port ref resolve <task-key> --project PROJECT [--json]`,
    ],
    [
      ['port', 'ref', 'delete-error'],
      1,
      `${PLATFORM_SLUG} doc port ref delete-error <task-key> --project PROJECT [--json]`,
    ],
    [['port', 'doctrine', 'list'], 0, ''],
    [
      ['port', 'doctrine', 'add'],
      1,
      `${PLATFORM_SLUG} doc port doctrine add <number> --title TEXT (--file F | body on stdin) [--json]`,
    ],
    [
      ['port', 'doctrine', 'retire'],
      1,
      `${PLATFORM_SLUG} doc port doctrine retire <number> [--json]`,
    ],
    [['project'], 0, 'no projects registered.'],
    [['project', 'list'], 0, 'no projects registered.'],
    [
      ['project', 'add'],
      0,
      `registered ${fixtureCwd.split('/').at(-1)}  (no stack — ${PLATFORM_SLUG} project set ${fixtureCwd.split('/').at(-1)} --stack ...)  ${fixtureCwd}`,
    ],
    [
      ['project', 'set'],
      1,
      `${PLATFORM_SLUG} project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]`,
    ],
    [
      ['project', 'select-profile'],
      1,
      `${PLATFORM_SLUG} project select-profile <project> --axis A --name N [--lens ID] [--version N] --reason TEXT`,
    ],
    [['project', 'migrate-create'], 1, `${PLATFORM_SLUG} project migrate-create <name> [--apply]`],
    [['project', 'remove'], 1, `${PLATFORM_SLUG} project remove <name>`],
    [['project', 'retire'], 1, `${PLATFORM_SLUG} project retire <name> [--undo]`],
    [
      ['project', 'push'],
      1,
      `no hosted record is configured for this install; run \`${PLATFORM_SLUG} record use <address>\` before running \`${PLATFORM_SLUG} project push\``,
    ],
    [['project', 'fill-record-ids'], 0, 'filled 0 project record ids'],
    [['subject'], 1, 'project is required'],
    ...['list', 'add', 'rename', 'define', 'reorder', 'retire'].map(
      (verb): CompatibilityCase => [['subject', verb], 1, 'project is required'],
    ),
  ]

  try {
    for (const [argv, code, firstLine, firstLinePrefix] of cases) {
      const result = await runRegisteredCommand(argv)
      if (firstLinePrefix) {
        expect(result.code, argv.join(' ')).toBe(code)
        expect(result.firstLine, argv.join(' ')).toStartWith(firstLine)
      } else {
        expect(result, argv.join(' ')).toEqual({ code, firstLine })
      }
    }
    expect(await runRegisteredCommand(['doc', 'bogus'])).toEqual({
      code: 1,
      firstLine: `unknown: ${PLATFORM_SLUG} doc bogus. Try list | get | show | search | set | reorder | lint | warnings | consume | rm | history | revision | diff | restore | subjects | export | import | resumes`,
    })
    expect(await runRegisteredCommand(['canon', 'bogus'])).toEqual({
      code: 1,
      firstLine: `unknown: ${PLATFORM_SLUG} doc canon. Try audit | mirror | import | hydrate | list | check | diff | eval | evals | lint | load`,
    })
    expect(await runRegisteredCommand(['port', 'ref', 'bogus'])).toEqual({
      code: 1,
      firstLine: `unknown: ${PLATFORM_SLUG} doc port ref bogus. Try list | show | set | resolve | delete-error`,
    })
    expect(await runRegisteredCommand(['project', 'bogus'])).toEqual({
      code: 1,
      firstLine: `unknown: ${PLATFORM_SLUG} project bogus. Try list | add | set | remove | retire | push | fill-record-ids`,
    })
    expect(await runRegisteredCommand(['subject', 'bogus', 'fixture-project'])).toEqual({
      code: 1,
      firstLine: `unknown subject command "bogus"; use ${PLATFORM_SLUG} doc subject --help`,
    })
  } finally {
    process.chdir(originalCwd)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
