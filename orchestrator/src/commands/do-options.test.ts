import { describe, expect, test } from 'bun:test'
import { doPositionals } from './do-options.ts'

describe('doPositionals', () => {
  test('bare and valued --mcp keep the prompt positional', () => {
    expect(doPositionals(['bun', 'orch', 'review-lens', '--mcp', 'Review X'])).toEqual([
      'review-lens',
      'Review X',
    ])
    expect(doPositionals(['bun', 'orch', 'review-lens', '--mcp', 'prefer', 'Review X'])).toEqual([
      'review-lens',
      'Review X',
    ])
  })

  test.each([
    [['do', 'implement', '--mcp', 'prefer', 'write the fix'], ['write the fix']],
    [['do', 'implement', '--mcp', '--key', 'DEV-1', 'write the fix'], ['write the fix']],
    [['do', 'implement', 'write the fix', '--mcp'], ['write the fix']],
    [['do', 'implement', '--keep-tree', '4', '--keep-tree-reason', 'why', 'go'], ['go']],
    [['do', 'implement', '--mcp=prefer', '--agent=grok', 'go'], ['go']],
    [['do', 'implement', '--follow', 'go'], ['go']],
    [
      ['do', 'implement', '--', '--mcp', 'prefer'],
      ['--mcp', 'prefer'],
    ],
  ])('%j has prompt words %j', (argv, expected) => {
    expect(doPositionals(argv)).toEqual(expected)
  })
})
