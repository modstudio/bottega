import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { unknownCommandMentions } from './doc-command-mentions.ts'

const known = [
  `${PLATFORM_SLUG} task`,
  `${PLATFORM_SLUG} task show`,
  `${PLATFORM_SLUG} doc`,
  `${PLATFORM_SLUG} doc canon`,
  `${PLATFORM_SLUG} doc canon hydrate`,
]

describe('customer guide command mentions', () => {
  test.each([
    ['known group', `\`${PLATFORM_SLUG} task\``, []],
    ['known nested verb', `\`${PLATFORM_SLUG} doc canon hydrate\``, []],
    [
      'unknown group',
      `\`${PLATFORM_SLUG} missing thing\``,
      [{ mention: `${PLATFORM_SLUG} missing`, replacement: null }],
    ],
    [
      'unknown verb under a known group',
      `\`${PLATFORM_SLUG} task missing\``,
      [{ mention: `${PLATFORM_SLUG} task missing`, replacement: null }],
    ],
    ['flag after the verb', `\`${PLATFORM_SLUG} task show --json\``, []],
    ['placeholder after the verb', `\`${PLATFORM_SLUG} task show <key>\``, []],
    [
      'fenced shell block',
      `\`\`\`sh\n${PLATFORM_SLUG} task missing\n\`\`\``,
      [{ mention: `${PLATFORM_SLUG} task missing`, replacement: null }],
    ],
    [
      'retired orch mention',
      '`orch doc get guide`',
      [{ mention: 'orch doc get guide', replacement: `${PLATFORM_SLUG} doc get guide` }],
    ],
    [
      'retired hub mention',
      '`hub task list`',
      [{ mention: 'hub task list', replacement: `${PLATFORM_SLUG} task list` }],
    ],
    ['prose containing the word', `Run ${PLATFORM_SLUG} to inspect the commands.`, []],
  ])('%s', (_name, body, expected) => {
    expect(unknownCommandMentions(body, known)).toEqual(expected)
  })
})
