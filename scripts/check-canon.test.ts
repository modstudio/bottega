import { describe, expect, test } from 'bun:test'
import {
  CANON_FILES,
  EXEMPTIONS,
  PREFIXES,
  checkBody,
  parseAlso,
  trackedSet,
  type Ctx,
} from './check-canon'
import { CONCERNS, PLATFORM_SLUG } from '../shared/brand.ts'

/**
 * Every check here has a false-positive twin. A check that fires on ordinary
 * prose is one somebody switches off, and it takes the useful checks with it.
 */

const TRACKED = new Set([
  'orchestrator/hooks/no-attribution.py',
  'shared/brand.ts',
  'scripts/check-boundaries.ts',
  'hub/web/src/routes/index.tsx',
  '.githooks/commit-msg',
])

const ctx: Ctx = {
  tracked: trackedSet(TRACKED),
  scripts: new Set(['check', 'build', 'typecheck']),
}

const DOC = 'AGENTS.md'

describe('prefixes', () => {
  test('are the concerns plus shared, scripts, and .githooks', () => {
    expect(PREFIXES).toEqual([
      ...CONCERNS.map((c) => `${c}/`),
      'shared/',
      'scripts/',
      '.githooks/',
    ])
  })
})

describe('canon files', () => {
  test('are the root AGENTS.md and one per concern, never CLAUDE.md', () => {
    expect(CANON_FILES).toEqual([
      'AGENTS.md',
      ...CONCERNS.map((c) => `${c}/AGENTS.md`),
    ])
    expect(CANON_FILES.some((f) => f.endsWith('CLAUDE.md'))).toBe(false)
  })
})

describe('a repo path', () => {
  test('is caught when it is not tracked', () => {
    const out = checkBody(DOC, 'arm `orchestrator/hooks/orch-heartbeat.sh`', ctx)
    expect(out.findings[0]?.message).toContain('not tracked')
    expect(out.findings[0]?.message).toContain('orchestrator/hooks/orch-heartbeat.sh')
    expect(out.findings[0]?.message).toContain(`${DOC}:1`)
    expect(out.examined).toBe(1)
  })

  test('does not fire on one that is tracked', () => {
    expect(checkBody(DOC, 'see `shared/brand.ts`', ctx).findings).toEqual([])
  })

  test('does not treat presence on disk as enough — untracked is still a miss', () => {
    // The incident: the file sat untracked in one tree. existsSync was green.
    const onDisk = new Set(TRACKED)
    // Deliberately not adding it to tracked, even though a naive exists() would.
    const strict: Ctx = { ...ctx, tracked: trackedSet(onDisk) }
    const out = checkBody(DOC, '`orchestrator/hooks/orch-heartbeat.sh`', strict)
    expect(out.findings).toHaveLength(1)
  })

  test('does not fire on a path the build writes', () => {
    expect(checkBody(DOC, 'serves `hub/web/dist`', ctx).findings).toEqual([])
  })

  test('still fires on a missing path beside a built one', () => {
    const out = checkBody(DOC, '`hub/web/dist` and `hub/nowhere.ts`', ctx)
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]?.name).toBe('hub/nowhere.ts')
  })

  test('resolves the fixed part of a glob', () => {
    expect(checkBody(DOC, 'routes in `hub/web/src/routes/**`', ctx).findings).toEqual([])
  })

  test('does not fire on a placeholder', () => {
    expect(checkBody(DOC, '`hub/web/src/routes/<name>`', ctx).findings).toEqual([])
  })

  test('does not read a git revision as a path', () => {
    expect(checkBody(DOC, 'recoverable from `1b07f45^`', ctx).findings).toEqual([])
  })

  test('does not read a path in another repository', () => {
    expect(checkBody(DOC, 'see `apps/api/src/kernel/mcp/`', ctx).findings).toEqual([])
  })

  test('does not read a historical retired concern as a path', () => {
    expect(checkBody(DOC, 'used to live at `port/`', ctx).findings).toEqual([])
  })

  test('does not read an un-prefixed relative path', () => {
    expect(checkBody(DOC, '`bin/projects-morning-refresh.sh`', ctx).findings).toEqual([])
  })

  test('strips the platform slug so an external file still resolves here', () => {
    const line = `\`${PLATFORM_SLUG}/orchestrator/hooks/orch-heartbeat.sh\``
    const out = checkBody('/tmp/CLAUDE.md', line, ctx)
    expect(out.findings[0]?.name).toBe('orchestrator/hooks/orch-heartbeat.sh')
  })

  test('extracts the path when the backtick also carries arguments', () => {
    const line = `\`${PLATFORM_SLUG}/orchestrator/hooks/orch-heartbeat.sh <session-id> [interval]\``
    const out = checkBody('/tmp/CLAUDE.md', line, ctx)
    expect(out.findings[0]?.name).toBe('orchestrator/hooks/orch-heartbeat.sh')
    expect(out.findings).toHaveLength(1)
  })
})

describe('a bun run script', () => {
  test('is caught when no package defines it', () => {
    expect(checkBody(DOC, '`bun run nope:here`', ctx).findings[0]?.name).toBe('nope:here')
  })

  test('does not fire on one that exists', () => {
    expect(checkBody(DOC, 'run `bun run check` first', ctx).findings).toEqual([])
  })

  test('does not read a file path as a script name', () => {
    expect(checkBody(DOC, 'bun run scripts/check-boundaries.ts', ctx).findings).toEqual([])
  })

  test('does not read a template interpolation as a script name', () => {
    expect(checkBody(DOC, 'bun run deploy:${r.name}', ctx).findings).toEqual([])
  })

  test('does not read a trailing comment as an invocation', () => {
    expect(checkBody(DOC, 'set -a  # REQUIRED before bun run scripts', ctx).findings).toEqual([])
  })
})

describe('an explicit exemption', () => {
  test('is the three named paths, each with a reason', () => {
    expect(EXEMPTIONS.map((e) => e.path)).toEqual([
      'orchestrator/orch.db',
      'scripts/worktree',
      'scripts/sync/main',
    ])
    for (const e of EXEMPTIONS) expect(e.reason.length).toBeGreaterThan(10)
  })

  test('does not fire on a named exemption', () => {
    expect(checkBody(DOC, 'store in `orchestrator/orch.db`', ctx).findings).toEqual([])
    expect(checkBody(DOC, 'asks `scripts/worktree resolve`', ctx).findings).toEqual([])
    expect(checkBody(DOC, 'its own `scripts/sync/main`', ctx).findings).toEqual([])
  })

  test('still fires on a cousin of an exempted path', () => {
    const out = checkBody(DOC, '`scripts/worktree.ts` and `orchestrator/hub.db`', ctx)
    expect(out.findings.map((f) => f.name).sort()).toEqual([
      'orchestrator/hub.db',
      'scripts/worktree.ts',
    ])
  })
})

describe('--also', () => {
  test('collects repeated flags', () => {
    expect(parseAlso(['--also', '/tmp/a.md', '--also', '/tmp/b.md'])).toEqual([
      '/tmp/a.md',
      '/tmp/b.md',
    ])
  })

  test('refuses a flag with no path', () => {
    expect(() => parseAlso(['--also'])).toThrow(/--also needs a path/)
  })
})
