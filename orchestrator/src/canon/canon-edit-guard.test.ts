import { describe, expect, test } from 'bun:test'
import settings from '../../../.claude/settings.json' with { type: 'json' }
import {
  CANON_COMPACT_MATCHER,
  CANON_EDIT_TOOLS,
  decideCanonEdit,
  type EnforcedContext,
} from './canon-edit-guard.ts'
import { parseTranscriptEvents, transcriptAfterWatermark } from './canon-edit-transcript.ts'

const root = '/repo'
const context: EnforcedContext = {
  path: '.agents/contexts/guarded.md',
  description: 'Rules for guarded source',
  globs: ['src/guarded/**'],
}

const line = (role: 'assistant' | 'user', content: unknown) =>
  JSON.stringify({ message: { role, content } })
const use = (id: string, name: string, input: unknown) =>
  line('assistant', [{ type: 'tool_use', id, name, input }])
const result = (id: string, content: unknown, isError = false) =>
  line('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }])
const events = (jsonl: string, watermark = 0) =>
  parseTranscriptEvents(jsonl.split('\n').filter(Boolean), watermark)
const decide = (
  tool: string,
  toolInput: unknown,
  transcript = '',
  extra: Partial<Parameters<typeof decideCanonEdit>[0]> = {},
) =>
  decideCanonEdit({
    managedContext: true,
    tool,
    toolInput,
    cwd: root,
    repoRoot: root,
    contexts: [context],
    events: events(transcript),
    ...extra,
  })

describe('canon pre-edit decision', () => {
  test('an unread enforced context denies with its description and exact Read path', () => {
    const decision = decide('Edit', { file_path: '/repo/src/guarded/a.ts' })
    expect(decision.allow).toBe(false)
    if (decision.allow) return
    expect(decision.reason).toContain('Rules for guarded source: .agents/contexts/guarded.md')
    expect(decision.reason).toContain('Read tool')
    expect(decision.reason).toContain('THIS session')
    expect(decision.reason).toContain('subagent must read it in its own session')
    expect(decision.reason).toContain('retry the same call')
    expect(decision.reason).toContain('Bash does not bypass')
  })

  test('only a paired successful Read of the context or rules alias allows', () => {
    for (const filePath of [
      '/repo/.agents/contexts/guarded.md',
      '/repo/.claude/rules/guarded.md',
    ]) {
      const transcript = `${use('read-1', 'Read', { file_path: filePath })}\n${result('read-1', 'body')}`
      expect(decide('Write', { file_path: 'src/guarded/a.ts' }, transcript)).toEqual({
        allow: true,
      })
    }
  })

  test('a relative context Read also resolves from the repo root when cwd is a subdirectory', () => {
    const transcript = `${use('read-1', 'Read', { file_path: '.agents/contexts/guarded.md' })}\n${result('read-1', 'body')}`
    expect(
      decide('Edit', { file_path: '/repo/src/guarded/a.ts' }, transcript, { cwd: '/repo/src' }),
    ).toEqual({ allow: true })
  })

  test('an errored or empty Read denies', () => {
    for (const readResult of [result('read-1', 'missing', true), result('read-1', '')]) {
      const transcript = `${use('read-1', 'Read', {
        file_path: '.agents/contexts/guarded.md',
      })}\n${readResult}`
      expect(decide('Edit', { file_path: 'src/guarded/a.ts' }, transcript).allow).toBe(false)
    }
  })

  test('a successful Read before the line watermark denies', () => {
    const lines = [
      use('read-1', 'Read', { file_path: '.agents/contexts/guarded.md' }),
      result('read-1', 'body'),
    ]
    expect(
      decide('Edit', { file_path: 'src/guarded/a.ts' }, '', {
        events: parseTranscriptEvents(lines, lines.length),
      }).allow,
    ).toBe(false)
  })

  test('an unknown watermark anchors before accepting later Reads', () => {
    const oldLines = [
      use('old', 'Read', { file_path: '.agents/contexts/guarded.md' }),
      result('old', 'body'),
    ]
    expect(transcriptAfterWatermark(oldLines, 'unknown')).toEqual({
      events: [],
      anchoredAt: 2,
    })
    const newLines = [
      ...oldLines,
      use('new', 'Read', { file_path: '.agents/contexts/guarded.md' }),
      result('new', 'body'),
    ]
    const window = transcriptAfterWatermark(newLines, 2)
    expect(
      decide('Edit', { file_path: 'src/guarded/a.ts' }, '', { events: window.events }),
    ).toEqual({ allow: true })
  })

  test('nonmatching globs, canon files, outside paths, and unmanaged projects allow', () => {
    expect(decide('Edit', { file_path: 'src/open.ts' })).toEqual({ allow: true })
    for (const filePath of [
      '.agents/contexts/guarded.md',
      'nested/AGENTS.md',
      'CLAUDE.md',
      '/outside/src/guarded/a.ts',
    ]) {
      expect(decide('Edit', { file_path: filePath })).toEqual({ allow: true })
    }
    expect(
      decide('Edit', { file_path: 'src/guarded/a.ts' }, '', { managedContext: false }),
    ).toEqual({ allow: true })
  })

  test('NotebookEdit guards notebook_path', () => {
    const guarded = { ...context, globs: ['notebooks/**'] }
    expect(
      decide('NotebookEdit', { notebook_path: 'notebooks/work.ipynb' }, '', {
        contexts: [guarded],
      }).allow,
    ).toBe(false)
  })
})

test('tracked hook matchers equal the declared tool and compact lists', () => {
  expect(settings.hooks.PreToolUse[0]?.matcher).toBe(CANON_EDIT_TOOLS.join('|'))
  expect(settings.hooks.SessionStart[0]?.matcher).toBe(CANON_COMPACT_MATCHER)
})
