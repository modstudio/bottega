import { describe, expect, test } from 'bun:test'
import {
  type CandidateFile,
  CLAUDE_COMBINED_NOTICE_CHARS,
  CLAUDE_FILE_MAX_BYTES,
  CLAUDE_IMPORT_MAX_HOPS,
  CODEX_PROJECT_DOC_MAX_BYTES,
  type HarnessLoadFacts,
  planHarnessLoad,
} from './canon-load.ts'

function file(path: string, text: string, extra?: Partial<CandidateFile>): CandidateFile {
  return { path, text, symlink: false, realPath: path, ...extra }
}

function facts(overrides: Partial<HarnessLoadFacts>): HarnessLoadFacts {
  return {
    files: [],
    directoryChain: ['/proj'],
    home: { claude: '/home/.claude', grok: '/home/.grok', codex: '/home/.codex' },
    env: { grokClaudeAgentsEnabled: true, grokClaudeRulesEnabled: true },
    ...overrides,
  }
}

function pathsOf(plan: ReturnType<typeof planHarnessLoad>): string[] {
  return plan.files.map((row) => row.path)
}

describe('planHarnessLoad', () => {
  test('a symlinked .claude/rules counts once', () => {
    const input = facts({
      files: [
        file('/proj/.claude/rules/keep.md', 'once', {
          symlink: true,
          realPath: '/proj/.agents/rules/keep.md',
        }),
        file('/proj/.agents/rules/keep.md', 'once', {
          realPath: '/proj/.agents/rules/keep.md',
        }),
      ],
    })
    const plan = planHarnessLoad(input, 'claude')
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]?.path).toBe('/proj/.claude/rules/keep.md')
    expect(plan.total).toBe('once'.length)
  })

  test('paths: makes a rule conditional for Claude but always-on for Grok', () => {
    const rule = `---
paths:
  - hub/**
---
scoped
`
    const input = facts({
      files: [file('/proj/.claude/rules/scoped.md', rule)],
    })
    const claude = planHarnessLoad(input, 'claude')
    const grok = planHarnessLoad(input, 'grok')
    expect(claude.files[0]?.kind).toBe('conditional')
    expect(claude.total).toBe(0)
    expect(claude.status).toBe('ok')
    expect(grok.files[0]?.kind).toBe('always-on')
    expect(grok.total).toBe(rule.length)
  })

  test('AGENTS.md is ignored by Claude when CLAUDE.md exists', () => {
    const input = facts({
      directoryChain: ['/proj', '/proj/pkg'],
      files: [
        file('/proj/CLAUDE.md', 'root-claude'),
        file('/proj/AGENTS.md', 'root-agents'),
        file('/proj/pkg/AGENTS.md', 'pkg-agents'),
      ],
    })
    const plan = planHarnessLoad(input, 'claude')
    expect(pathsOf(plan).sort()).toEqual(['/proj/CLAUDE.md', '/proj/pkg/AGENTS.md'])
    expect(plan.total).toBe('root-claude'.length + 'pkg-agents'.length)
  })

  test('Codex truncation past the cap reports the cut', () => {
    const first = 'a'.repeat(CODEX_PROJECT_DOC_MAX_BYTES - 10)
    const second = 'b'.repeat(100)
    const user = 'u'.repeat(50)
    const input = facts({
      directoryChain: ['/proj', '/proj/pkg'],
      files: [
        file('/home/.codex/AGENTS.md', user),
        file('/proj/AGENTS.md', first),
        file('/proj/pkg/AGENTS.md', second),
      ],
    })
    const plan = planHarnessLoad(input, 'codex')
    expect(plan.status).toBe('truncated')
    expect(plan.total).toBe(CODEX_PROJECT_DOC_MAX_BYTES)
    expect(plan.limit).toBe(CODEX_PROJECT_DOC_MAX_BYTES)
    expect(plan.cut).toEqual([{ path: '/proj/pkg/AGENTS.md', omitted: 90 }])
    const project = plan.files.find((row) => row.path === '/proj/pkg/AGENTS.md')
    expect(project?.loadedSize).toBe(10)
    expect(plan.files.find((row) => row.path === '/home/.codex/AGENTS.md')?.size).toBe(50)
  })

  test('Codex chooses the generated override instead of the root entry', () => {
    const input = facts({
      files: [
        file('/proj/AGENTS.md', 'entry-only'),
        file('/proj/AGENTS.override.md', 'entry-and-rules'),
      ],
    })

    const plan = planHarnessLoad(input, 'codex')
    expect(pathsOf(plan)).toEqual(['/proj/AGENTS.override.md'])
    expect(plan.total).toBe(Buffer.byteLength('entry-and-rules'))
  })

  test('the Grok env toggles remove the Claude-compat files', () => {
    const input = facts({
      files: [
        file('/home/.claude/CLAUDE.md', 'compat'),
        file('/home/.grok/AGENTS.md', 'grok'),
        file('/proj/.claude/rules/r.md', 'crule'),
        file('/proj/.grok/rules/g.md', 'grule'),
      ],
      env: { grokClaudeAgentsEnabled: false, grokClaudeRulesEnabled: false },
    })
    const plan = planHarnessLoad(input, 'grok')
    expect(pathsOf(plan).sort()).toEqual(['/home/.grok/AGENTS.md', '/proj/.grok/rules/g.md'])
    const enabled = planHarnessLoad(
      { ...input, env: { grokClaudeAgentsEnabled: true, grokClaudeRulesEnabled: true } },
      'grok',
    )
    expect(pathsOf(enabled).sort()).toEqual([
      '/home/.claude/CLAUDE.md',
      '/home/.grok/AGENTS.md',
      '/proj/.claude/rules/r.md',
      '/proj/.grok/rules/g.md',
    ])
  })

  test('an @import counts', () => {
    const origin = '@./extra.md\n'
    const imported = 'imported-body'
    const input = facts({
      files: [file('/proj/CLAUDE.md', origin), file('/proj/extra.md', imported)],
    })
    const plan = planHarnessLoad(input, 'claude')
    expect(pathsOf(plan).sort()).toEqual(['/proj/CLAUDE.md', '/proj/extra.md'])
    expect(plan.total).toBe(origin.length + imported.length)
    expect(plan.files.find((row) => row.path === '/proj/extra.md')?.reason).toContain('@import')
  })

  test('an external import is marked external', () => {
    const origin = '@/outside/secret.md\n'
    const input = facts({
      files: [
        file('/home/.claude/CLAUDE.md', 'user-claude'),
        file('/proj/CLAUDE.md', origin),
        file('/outside/secret.md', 'secret-body'),
      ],
    })
    const plan = planHarnessLoad(input, 'claude')
    expect(plan.files.find((row) => row.path === '/outside/secret.md')?.external).toBe(true)
    expect(plan.files.find((row) => row.path === '/proj/CLAUDE.md')?.external).toBe(false)
    expect(plan.files.find((row) => row.path === '/home/.claude/CLAUDE.md')?.external).toBe(false)
    expect(plan.total).toBe('user-claude'.length + origin.length + 'secret-body'.length)
  })

  test('an oversized file is skipped', () => {
    const size = CLAUDE_FILE_MAX_BYTES + 1
    const input = facts({
      files: [file('/proj/CLAUDE.md', '', { skipped: { byteSize: size } })],
    })
    const plan = planHarnessLoad(input, 'claude')
    expect(plan.files).toEqual([])
    expect(plan.total).toBe(0)
    expect(plan.skipped).toEqual([
      { path: '/proj/CLAUDE.md', size, reason: 'exceeds CLAUDE_FILE_MAX_BYTES' },
    ])
    const agents = file('/proj/AGENTS.md', '', { skipped: { byteSize: size } })
    const codex = planHarnessLoad(facts({ files: [agents] }), 'codex')
    expect(codex.files).toEqual([])
    expect(codex.skipped).toEqual([
      { path: '/proj/AGENTS.md', size, reason: 'exceeds CLAUDE_FILE_MAX_BYTES' },
    ])
  })

  test('Claude @imports stop after CLAUDE_IMPORT_MAX_HOPS', () => {
    const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
    const files = [
      file('/proj/CLAUDE.md', '@./a.md\n'),
      ...names.map((name, index) => {
        const next = names[index + 1]
        return file(`/proj/${name}`, next ? `@./${next}\n` : 'end')
      }),
    ]
    const plan = planHarnessLoad(facts({ files }), 'claude')
    expect(pathsOf(plan).sort()).toEqual(
      ['/proj/CLAUDE.md', '/proj/a.md', '/proj/b.md', '/proj/c.md', '/proj/d.md'].sort(),
    )
    expect(pathsOf(plan)).not.toContain('/proj/e.md')
    expect(CLAUDE_IMPORT_MAX_HOPS).toBe(4)
    expect(CLAUDE_COMBINED_NOTICE_CHARS).toBe(150000)
  })
})
