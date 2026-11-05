import { expect, test } from 'bun:test'
import { instructionItem } from '@/routes/-personal-instructions'

const row = {
  slug: '.agents/rules/web.md',
  title: 'Web rules',
  body: '---\ndescription: Web rules\npaths: [hub/web/**, hub/views/**]\n---\n',
  revision: 'revision-1',
  updated_at: '2026-09-25T12:00:00.000Z',
}

test('user canon rules with paths are shown as path-scoped at their agent home path', () => {
  expect(instructionItem(row)).toMatchObject({
    delivery: 'path',
    reach: [
      {
        agent: 'Claude Code',
        path: '~/.claude/rules/web.md',
        paths: ['hub/web/**', 'hub/views/**'],
      },
    ],
  })
})

test('nested and non-markdown rule slugs stay on demand', () => {
  for (const slug of ['.agents/rules/sub/x.md', '.agents/rules/x.txt']) {
    expect(instructionItem({ ...row, slug })).toMatchObject({ delivery: 'demand', reach: [] })
  }
})
