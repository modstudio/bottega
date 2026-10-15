import { expect, test } from 'bun:test'
import { Command, Option } from 'commander'
import type { CommandRoute } from '../cli/routes.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { type DocumentationInventory, documentationInventory } from './command-descriptions.ts'
import { REGENERATE_COMMAND, renderReferencePages } from './command-reference.ts'

function fixture(description = 'show one run'): DocumentationInventory {
  return {
    units: [],
    notWalked: [`${PLATFORM_SLUG} run legacy`],
    groups: [
      { name: 'run', description: 'dispatch and inspect runs' },
      { name: 'other', description: 'other tools' },
    ],
    commands: [
      {
        spelling: `${PLATFORM_SLUG} run`,
        group: 'run',
        description: 'dispatch and inspect runs',
        arguments: [],
        options: [
          {
            flags: '-h, --help',
            valuePlaceholder: null,
            description: 'display help for command',
            default: null,
          },
        ],
        examples: [],
        optionsByHelp: false,
      },
      {
        spelling: `${PLATFORM_SLUG} run show`,
        group: 'run',
        description,
        arguments: [{ name: 'id', required: false, variadic: false }],
        options: [
          {
            flags: '--format <name>',
            valuePlaceholder: '<name>',
            description: 'select the output format',
            default: { kind: 'literal', text: 'json' },
          },
          {
            flags: '--cwd <path>',
            valuePlaceholder: '<path>',
            description: 'working directory',
            default: { kind: 'cwd' },
          },
          {
            flags: '--home <path>',
            valuePlaceholder: '<path>',
            description: 'home directory',
            default: { kind: 'env', name: 'HOME' },
          },
          {
            flags: '-h, --help',
            valuePlaceholder: null,
            description: 'display help for command',
            default: null,
          },
        ],
        examples: [`${PLATFORM_SLUG} run show 1`],
        optionsByHelp: false,
      },
      {
        spelling: `${PLATFORM_SLUG} run show nested`,
        group: 'run',
        description: 'show a nested run',
        arguments: [],
        options: [],
        examples: [],
        optionsByHelp: false,
      },
      {
        spelling: `${PLATFORM_SLUG} run legacy`,
        group: 'run',
        description: 'legacy dispatcher',
        arguments: [{ name: 'args', required: false, variadic: true }],
        options: [],
        examples: [],
        optionsByHelp: true,
      },
      {
        spelling: `${PLATFORM_SLUG} other`,
        group: 'other',
        description: 'other tools',
        arguments: [],
        options: [],
        examples: [],
        optionsByHelp: false,
      },
    ],
  }
}

function commandSection(page: string, spelling: string): string {
  const heading = `## ${spelling}\n`
  const start = page.indexOf(heading)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = page.slice(start + heading.length)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('a fixture inventory renders the fixed command shape', () => {
  const pages = renderReferencePages(fixture())
  expect(pages.map((page) => page.file)).toEqual(['index.md', 'run.md', 'other.md'])
  const index = pages[0]!.content
  expect(index).toContain(GeneratedHeaderSnippet())
  expect(index).toContain('Every command accepts `--help`.')
  expect(index).toContain('- [run](./run.md) — dispatch and inspect runs')
  const page = pages[1]!.content
  expect(page).toContain(
    `# run\n\ndispatch and inspect runs\n\n- [${PLATFORM_SLUG} run](#${PLATFORM_SLUG}-run)\n- [${PLATFORM_SLUG} run legacy](#${PLATFORM_SLUG}-run-legacy)\n- [${PLATFORM_SLUG} run show](#${PLATFORM_SLUG}-run-show)\n- [${PLATFORM_SLUG} run show nested](#${PLATFORM_SLUG}-run-show-nested)\n`,
  )
  expect(page).toContain(`## ${PLATFORM_SLUG} run show`)
  expect(page).toContain(
    `**Synopsis:** \`${PLATFORM_SLUG} run show [id] [--format <name>] [--cwd <path>] [--home <path>]\``,
  )
  expect(page).toContain('show one run')
  expect(page).toContain('- `--format <name>`: select the output format (default: json)')
  expect(page).toContain('### Examples')
  expect(page).toContain(`- \`${PLATFORM_SLUG} run show 1\``)
  expect(page).toContain(`## ${PLATFORM_SLUG} run legacy`)
  expect(page).toContain('Options are documented by `--help`.')
  expect(page).not.toContain('### Examples\n\n### Related')
  expect(page).not.toContain('[--help]')
  expect(page).not.toContain('-h, --help')
})

test('a nested command links its parent and a leaf with no parent has no Related section', () => {
  const pages = renderReferencePages(fixture())
  const page = pages[1]!.content
  const parent = commandSection(page, `${PLATFORM_SLUG} run`)
  const show = commandSection(page, `${PLATFORM_SLUG} run show`)
  const nested = commandSection(page, `${PLATFORM_SLUG} run show nested`)
  const legacy = commandSection(page, `${PLATFORM_SLUG} run legacy`)
  expect(parent).toContain('### Related')
  expect(parent).toContain(`- [${PLATFORM_SLUG} run show](./run.md#${PLATFORM_SLUG}-run-show)`)
  expect(parent).toContain(`- [${PLATFORM_SLUG} run legacy](./run.md#${PLATFORM_SLUG}-run-legacy)`)
  expect(parent).not.toContain(`${PLATFORM_SLUG} run show nested`)
  expect(parent).not.toContain(`](./run.md)`)
  expect(show).toContain(`- [${PLATFORM_SLUG} run](./run.md#${PLATFORM_SLUG}-run)`)
  expect(show).toContain(
    `- [${PLATFORM_SLUG} run show nested](./run.md#${PLATFORM_SLUG}-run-show-nested)`,
  )
  expect(show).not.toContain(`${PLATFORM_SLUG} run legacy`)
  expect(nested).toContain(`- [${PLATFORM_SLUG} run show](./run.md#${PLATFORM_SLUG}-run-show)`)
  expect(nested).not.toContain(`${PLATFORM_SLUG} run legacy`)
  expect(nested).not.toContain(`- [${PLATFORM_SLUG} run](`)
  expect(legacy).toContain(`- [${PLATFORM_SLUG} run](./run.md#${PLATFORM_SLUG}-run)`)
  expect(legacy).not.toContain(`${PLATFORM_SLUG} run show`)
  expect(pages[2]!.content).not.toContain('### Related')
})

test('a cwd or environment default from a real command renders as a phrase, never a path', () => {
  const programs = { orch: new Command('orch'), hub: new Command('hub') }
  programs.orch
    .command('create')
    .description('create a tree')
    .option('--cwd <path>', 'select the project', process.cwd())
    .addOption(new Option('--home <path>', 'select the home').env('HOME'))
  const routes = [
    { command: ['tree', 'create'], owner: 'orch', argv: ['create'] },
  ] satisfies CommandRoute[]
  const content = renderReferencePages(
    documentationInventory([['tree', 'create and release worktrees']], routes, programs),
  )
    .map((page) => page.content)
    .join('\n')
  expect(content).toContain('(default: the current working directory)')
  expect(content).toContain('(default: the value of HOME)')
  expect(content).not.toContain(process.cwd())
})

function GeneratedHeaderSnippet() {
  return `Generated by \`${REGENERATE_COMMAND}\`. Do not edit by hand.`
}
