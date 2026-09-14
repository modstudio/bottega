import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hermeticGitCommand } from '../test/fixtures/git.ts'
import { compoundCreate, declaredCreate, worktreeDescribeFixture } from '../test/fixtures/worktree.ts'
import { db } from './db.ts'
import { preflight } from './dispatch-preflight.ts'
import { upsertProject } from './projects.ts'
import { run as runJob } from './run.ts'
import { createWithTool } from './worktree.ts'
describe('worktree tool capability', () => {
const { fromRoot, git, scratchRepo } = worktreeDescribeFixture()
test('preflight passes a project-specific seed spec intact to the project resolver', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const received = join(repo, 'received-seed')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then
  shift
  for arg in "$@"; do printf '%s\\n' "$arg" >> "${received}"; done
  printf -- '---\\n' >> "${received}"
  exit 0
fi
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'custom-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', { expand: 'seed' }]), branch: 'task/{id}',
          seeds: ['none', 'minimal', 'full'],
        },
      },
    })
    const seeds = [
      '--full --budget-mb=2000', '--bundle=tanach --bundle=word-bank',
      'none', 'minimal', 'full',
    ]
    for (const seed of seeds) {
      expect(() => fromRoot(() => preflight('implement', repo, seed))).not.toThrow()
    }
    expect(readFileSync(received, 'utf8')).toBe(
      '--full\n--budget-mb=2000\n---\n' +
      '--bundle=tanach\n--bundle=word-bank\n---\n' +
      'none\n---\nminimal\n---\nfull\n---\n',
    )
    rmSync(repo, { recursive: true, force: true })
  })

test('a resolver refusal happens before a run row or worktree can exist', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-rejected-seed-'))
    git(repo, 'init', '-b', 'main')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const created = join(repo, 'create-ran')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then echo 'over budget' >&2; exit 2; fi
touch "${created}"
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'rejected-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}', seeds: ['full'],
        },
      },
    })
    const started = performance.now()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({ job: 'implement', prompt: 'change it', cwd: repo, seed: 'full' }))
        .rejects.toThrow("the project's seed resolver rejected the seed:\nover budget")
      expect(performance.now() - started).toBeLessThan(1000)
      expect(existsSync(created)).toBe(false)
      expect(existsSync(join(repo, '.claude', 'worktrees'))).toBe(false)
      expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(0)
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a resolver failure is not treated as a successful check', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
echo 'catalog unreachable' >&2
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'unchecked-seed', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'minimal'))).toThrow(
      "the project's seed resolver rejected the seed or could not check it:\ncatalog unreachable",
    )
    rmSync(repo, { recursive: true, force: true })
  })

test('a project whose worktree tool exposes no resolver still accepts its seed', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
echo 'Usage: scripts/worktree create [seed]'
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'no-resolver', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, '--anything=project-specific')))
      .not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

test('the path is read from stdout, whatever the tool says on stderr afterwards', () => {
    // One project's shape: path on stdout, progress on stderr, and the progress
    // printed last. Joining the streams put a progress line where the path
    // should be and sent run 735 to a directory nothing had created.
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'technical_sto_993_orch_735')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}" && ` +
            `echo 'Database cloned.' >&2 && echo 'task status not written' >&2`),
        },
        process.cwd(),
        735,
      )
      expect(w.path).toBe(custom)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a tool that prints its path is believed, not second-guessed', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'custom-657')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        process.cwd(),
        657,
      )
      expect(w.path).toBe(custom)
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-657'))).toBe(false)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
