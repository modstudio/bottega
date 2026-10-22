import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { unknownCommandMentions } from './doc-command-mentions.ts'

const known = [
  `${PLATFORM_SLUG} task`,
  `${PLATFORM_SLUG} task show`,
  `${PLATFORM_SLUG} doc`,
  `${PLATFORM_SLUG} doc canon`,
  `${PLATFORM_SLUG} doc canon hydrate`,
  `${PLATFORM_SLUG} score`,
  `${PLATFORM_SLUG} score pending`,
]

describe('customer guide command mentions', () => {
  test.each([
    ['known group', `\`${PLATFORM_SLUG} task\``, []],
    ['known nested verb', `\`${PLATFORM_SLUG} doc canon hydrate\``, []],
    [
      'unknown group',
      `\`${PLATFORM_SLUG} missing thing\``,
      [{ mention: `${PLATFORM_SLUG} missing` }],
    ],
    [
      'unknown verb under a known group',
      `\`${PLATFORM_SLUG} task missing\``,
      [{ mention: `${PLATFORM_SLUG} task missing` }],
    ],
    ['flag after the verb', `\`${PLATFORM_SLUG} task show --json\``, []],
    ['placeholder after the verb', `\`${PLATFORM_SLUG} task show <key>\``, []],
    [
      'fenced shell block',
      `\`\`\`sh\n${PLATFORM_SLUG} task missing\n\`\`\``,
      [{ mention: `${PLATFORM_SLUG} task missing` }],
    ],
    [
      'prompted unknown command',
      `\`\`\`sh\n$ ${PLATFORM_SLUG} task missing\n\`\`\``,
      [{ mention: `${PLATFORM_SLUG} task missing` }],
    ],
    ['prompted known command', `\`\`\`sh\n% ${PLATFORM_SLUG} task show\n\`\`\``, []],
    [
      'unknown command in a later pipeline segment',
      `\`\`\`sh\n${PLATFORM_SLUG} task show | ${PLATFORM_SLUG} task missing\n\`\`\``,
      [{ mention: `${PLATFORM_SLUG} task missing` }],
    ],
    [
      'tilde fence',
      `~~~sh\n${PLATFORM_SLUG} task missing\n~~~`,
      [{ mention: `${PLATFORM_SLUG} task missing` }],
    ],
    ['all-capitals placeholder', `\`${PLATFORM_SLUG} task show RUN_ID\``, []],
    ['numeric argument after a group', `\`${PLATFORM_SLUG} score 42 full right\``, []],
    ['heading containing a known command', `# Run \`${PLATFORM_SLUG} task show\``, []],
    ['table cell containing a known command', `| command | \`${PLATFORM_SLUG} task show\` |`, []],
    ['retired orchestrator mention', '`orch doc get guide`', [{ mention: 'orch doc get guide' }]],
    ['retired hub mention', '`hub task list`', [{ mention: 'hub task list' }]],
    ['prose containing the word', `Run ${PLATFORM_SLUG} to inspect the commands.`, []],
  ])('%s', (_name, body, expected) => {
    expect(unknownCommandMentions(body, known)).toEqual(expected)
  })
})
