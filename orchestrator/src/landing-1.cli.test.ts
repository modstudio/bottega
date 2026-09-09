import { describe, expect, test } from 'bun:test'
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addRun, cleanCompletedSequencerState, completeReview, contentTree, db, gateFailureSummary, getReview, hermeticGitEnv, land, landingReviewCoverage, listReviews, prepareSharedRefGuard, projectLockState, recordReviews, reviewPins, reviewReply, upsertProject, withProjectLock } from '../test/fixture.ts'

import { landingDescribeFixture } from '../test/fixture.ts'
import shards from '../test/shards.json'
import { elapsedAssertionMs, elapsedLockTimeoutMs, type TestSize } from './gate-policy.ts'

const landingSize = (shards.files['src/landing-1.cli.test.ts'] as { size: TestSize }).size
const ELAPSED_MS = elapsedAssertionMs(landingSize)
const LOCK_TIMEOUT_MS = elapsedLockTimeoutMs(landingSize)

describe("landing is gated on the exact commit that reaches trunk", () => {
  const { worktreeModule, g, repoWithBranches, childLand, completedReview, realTimeoutGate } = landingDescribeFixture()
  const orchModule = fileURLToPath(new URL('./orch.ts', import.meta.url))
  const childOrchLand = (repo: string, branch: string) => Bun.spawn(
    [process.execPath, orchModule, 'land', branch, '--unreviewed', 'residue fixture', '--wait'],
    {
      cwd: repo,
      env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, CLAUDE_CODE_SESSION_ID: branch },
      stdout: 'pipe', stderr: 'pipe',
    },
  )
test('only bun\'s complete timeout line reports machine load', () => {
    const unrelated = gateFailureSummary(
      'backup timed out after 10ms\n1 fail\n', '/tmp/gate.log', 7,
    )
    expect(unrelated).not.toContain('gate timeout under load')
    const bun = gateFailureSummary(
      '\u001b[31m  ^ this test timed out after 5000ms.\u001b[0m\n1 fail\n',
      '/tmp/gate.log', 7,
    )
    expect(bun).toContain(
      'gate timeout under load: 7 orch runs live (running + asking) machine-wide',
    )
  })

  test('a buried multi-file failure retains shard, file, test and assertion frame', () => {
    const output = [
      '[worker-2] shard 2/4',
      'src/passing.test.ts:',
      '(pass) earlier file passes',
      'src/early.test.ts:',
      '  17 | expect(received).toBe(expected)',
      'error: expect(received).toBe(expected)',
      'Expected: 4',
      'Received: 3',
      '      at <anonymous> (src/early.test.ts:17:20)',
      '(fail) early suite > reports the real assertion',
      'src/later.test.ts:',
      ...Array.from({ length: 50 }, (_, i) => `(pass) later test ${i + 1}`),
      '50 pass',
      '1 fail',
    ].join('\n')
    const summary = gateFailureSummary(output, '/tmp/multi-file-gate.log', 0)
    expect(summary).toContain('[worker-2] shard 2/4')
    expect(summary).toContain('src/early.test.ts:')
    expect(summary).toContain('(fail) early suite > reports the real assertion')
    expect(summary).toContain('error: expect(received).toBe(expected)\nExpected: 4\nReceived: 3')
    expect(summary).toContain('at <anonymous> (src/early.test.ts:17:20)')
  })

  test('unowned sequencer residue is refused before the gate', async () => {
    const { repo, trees } = repoWithBranches(['sequencer-residue'])
    const marker = g(trees['sequencer-residue']!, 'rev-parse', '--path-format=absolute', '--git-path', 'AUTO_MERGE')
    writeFileSync(marker, `${g(trees['sequencer-residue']!, 'rev-parse', 'HEAD')}\n`)
    upsertProject({ name: 'landing-sequencer-residue', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'sequencer-residue')
      expect(await child.exited).not.toBe(0)
      expect(existsSync(marker)).toBe(true)
      expect(await new Response(child.stderr).text()).toMatch(/was not created by this landing process[\s\S]*invariant:[\s\S]*cleared by:/)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a stopped rebase is live and residue cleanup refuses it', () => {
    const { repo, trees } = repoWithBranches(['live-rebase'])
    const tree = trees['live-rebase']!
    try {
      writeFileSync(join(repo, 'conflict'), 'trunk\n'); g(repo, 'add', 'conflict'); g(repo, 'commit', '-m', 'DEV-388 trunk conflict')
      writeFileSync(join(tree, 'conflict'), 'branch\n'); g(tree, 'add', 'conflict'); g(tree, 'commit', '-m', 'DEV-388 branch conflict')
      expect(Bun.spawnSync(['git', 'rebase', 'main'], { cwd: tree, env: hermeticGitEnv() }).exitCode).not.toBe(0)
      expect(() => cleanCompletedSequencerState(tree)).toThrow(/live Git operation REBASE_HEAD[\s\S]*invariant:[\s\S]*cleared by: git -C .* rebase --abort/)
      expect(g(tree, 'rev-parse', '--verify', 'REBASE_HEAD')).not.toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('ordinary leftover rebase residue is cleared by confirmed rebase quit', () => {
    const { repo, trees } = repoWithBranches(['stale-rebase'])
    const tree = trees['stale-rebase']!
    try {
      writeFileSync(join(repo, 'conflict'), 'trunk\n'); g(repo, 'add', 'conflict'); g(repo, 'commit', '-m', 'DEV-388 trunk conflict')
      writeFileSync(join(tree, 'conflict'), 'branch\n'); g(tree, 'add', 'conflict'); g(tree, 'commit', '-m', 'DEV-388 branch conflict')
      expect(Bun.spawnSync(['git', 'rebase', 'main'], { cwd: tree, env: hermeticGitEnv() }).exitCode).not.toBe(0)
      const marker = g(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'REBASE_HEAD')
      const rebaseDir = dirname(marker) + '/rebase-merge'
      rmSync(marker, { force: true })
      g(tree, 'reset', '--hard', 'ORIG_HEAD')
      let message = ''
      try { cleanCompletedSequencerState(tree) } catch (error) { message = (error as Error).message }
      expect(message).toMatch(/residue rebase-merge was not created by this landing process[\s\S]*invariant:[\s\S]*cleared by: first confirm no rebase process is running against .*; then git -C .* rebase --quit/)
      expect(existsSync(rebaseDir)).toBe(true)
      // The conflicting rebase child has exited, which is this fixture's liveness confirmation.
      expect(Bun.spawnSync(['git', 'rebase', '--quit'], { cwd: tree, env: hermeticGitEnv() }).exitCode).toBe(0)
      expect(() => cleanCompletedSequencerState(tree)).not.toThrow()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('orch land reports empty rebase residue and its remedy unblocks the next landing', async () => {
    const { repo, trees } = repoWithBranches(['empty-rebase-residue'])
    const tree = trees['empty-rebase-residue']!
    const rebaseDir = g(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')
    upsertProject({ name: 'landing-empty-rebase-residue', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      mkdirSync(rebaseDir)
      expect(g(tree, 'symbolic-ref', '--short', 'HEAD')).toBe('empty-rebase-residue')
      const first = childOrchLand(repo, 'empty-rebase-residue')
      expect(await first.exited).not.toBe(0)
      const message = await new Response(first.stderr).text()
      expect(message).toContain(
        `refusing cleanup in ${tree}: Git operation residue rebase-merge was not created by this landing process\n` +
        'invariant: Git operation residue is cleaned only when orch started the operation and its child process has exited.\n' +
        `cleared by: rmdir -- '${rebaseDir}'`,
      )
      expect(Bun.spawnSync(['rmdir', '--', rebaseDir], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
      const second = childOrchLand(repo, 'empty-rebase-residue')
      expect(await second.exited, await new Response(second.stderr).text()).toBe(0)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('orch land reports non-empty rebase residue and its remedy unblocks the next landing', async () => {
    const { repo, trees } = repoWithBranches(['partial-rebase-residue'])
    const tree = trees['partial-rebase-residue']!
    const rebaseDir = g(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')
    upsertProject({ name: 'landing-partial-rebase-residue', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      mkdirSync(rebaseDir)
      writeFileSync(join(rebaseDir, 'orig-head'), `${g(tree, 'rev-parse', 'HEAD^')}\n`)
      const before = g(tree, 'rev-parse', 'HEAD')
      expect(g(tree, 'symbolic-ref', '--short', 'HEAD')).toBe('partial-rebase-residue')
      const first = childOrchLand(repo, 'partial-rebase-residue')
      expect(await first.exited).not.toBe(0)
      const message = await new Response(first.stderr).text()
      expect(message).toContain(
        `refusing cleanup in ${tree}: Git operation residue rebase-merge was not created by this landing process\n` +
        'invariant: Git operation residue is cleaned only when orch started the operation and its child process has exited.\n' +
        `cleared by: first confirm no rebase process is running against '${tree}'; then git -C '${tree}' rebase --quit`,
      )
      expect(Bun.spawnSync(['git', 'rebase', '--quit'], { cwd: tree, env: hermeticGitEnv() }).exitCode).toBe(0)
      expect(g(tree, 'rev-parse', 'HEAD')).toBe(before)
      const second = childOrchLand(repo, 'partial-rebase-residue')
      expect(await second.exited, await new Response(second.stderr).text()).toBe(0)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an applying rebase with no REBASE_HEAD is refused without cleanup', async () => {
    const { repo, trees } = repoWithBranches(['applying-rebase'])
    const tree = trees['applying-rebase']!
    const editor = join(repo, 'pause-sequence-editor.sh')
    const ready = join(repo, 'sequence-editor-ready')
    const release = join(repo, 'sequence-editor-release')
    writeFileSync(editor, '#!/bin/sh\ntouch "$ORCH_TEST_READY"\nwhile test ! -e "$ORCH_TEST_RELEASE"; do sleep 0.01; done\n')
    chmodSync(editor, 0o755)
    const child = Bun.spawn(['git', 'rebase', '-i', 'main'], {
      cwd: tree,
      env: { ...hermeticGitEnv(), GIT_SEQUENCE_EDITOR: editor,
        ORCH_TEST_READY: ready, ORCH_TEST_RELEASE: release },
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      for (let i = 0; i < 500 && !existsSync(ready); i++) await Bun.sleep(10)
      expect(existsSync(ready)).toBe(true)
      expect(Bun.spawnSync(['git', 'rev-parse', '--verify', 'REBASE_HEAD'], {
        cwd: tree, env: hermeticGitEnv(), stdout: 'ignore', stderr: 'ignore',
      }).exitCode).not.toBe(0)
      const rebaseDir = g(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')
      expect(existsSync(rebaseDir)).toBe(true)
      expect(() => cleanCompletedSequencerState(tree)).toThrow(/residue rebase-merge was not created by this landing process/)
      expect(existsSync(rebaseDir)).toBe(true)
    } finally {
      writeFileSync(release, '')
      await child.exited
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a live merge plus empty rebase residue names and clears both findings', () => {
    const { repo, trees } = repoWithBranches(['merge-one', 'merge-two'])
    const tree = trees['merge-one']!
    try {
      writeFileSync(join(tree, 'conflict'), 'one\n'); g(tree, 'add', 'conflict'); g(tree, 'commit', '-m', 'DEV-388 merge one')
      writeFileSync(trees['merge-two']! + '/conflict', 'two\n'); g(trees['merge-two']!, 'add', 'conflict'); g(trees['merge-two']!, 'commit', '-m', 'DEV-388 merge two')
      expect(Bun.spawnSync(['git', 'merge', 'merge-two'], { cwd: tree, env: hermeticGitEnv() }).exitCode).not.toBe(0)
      const rebaseDir = join(g(tree, 'rev-parse', '--path-format=absolute', '--git-dir'), 'rebase-merge')
      mkdirSync(rebaseDir)
      let message = ''
      try { cleanCompletedSequencerState(tree) } catch (error) { message = (error as Error).message }
      expect(message).toContain('live Git operation MERGE_HEAD')
      expect(message).toContain('Git operation residue rebase-merge')
      expect(existsSync(rebaseDir)).toBe(true)
      expect(Bun.spawnSync(['git', 'merge', '--abort'], { cwd: tree, env: hermeticGitEnv() }).exitCode).toBe(0)
      rmdirSync(rebaseDir)
      g(tree, 'update-ref', '-d', 'AUTO_MERGE')
      expect(() => cleanCompletedSequencerState(tree)).not.toThrow()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('preflight and coverage plus tier/dependency facts precede the gate', async () => {
    const { repo, trees } = repoWithBranches(['ordered-preflight'])
    const order = join(repo, 'landing-order')
    const tree = trees['ordered-preflight']!
    upsertProject({ name: 'landing-ordered-preflight', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    completedReview('landing-ordered-preflight', [g(tree, 'rev-parse', 'HEAD^{tree}')], {
      branch: 'ordered-preflight', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: tree,
    })
    try {
      const child = childLand(repo, 'ordered-preflight', { unreviewed: null }, {
        ORCH_TEST_LANDING_ORDER: order,
      })
      expect(await child.exited).toBe(0)
      const steps = readFileSync(order, 'utf8').trim().split('\n')
      expect(steps.indexOf('preflight')).toBeLessThan(steps.indexOf('gate'))
      expect(steps.indexOf('coverage')).toBeLessThan(steps.indexOf('gate'))
      expect(steps.indexOf('tier-and-dependencies')).toBeLessThan(steps.indexOf('gate'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a main checkout on another branch refuses before the gate and records its cause', async () => {
    const { repo } = repoWithBranches(['wrong-main-head'])
    g(repo, 'switch', '-c', 'other-main-branch')
    upsertProject({ name: 'landing-wrong-main-head', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'wrong-main-head')
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error).toContain('is on other-main-branch, not main')
      expect(error).toContain('invariant:')
      expect(error).toContain('cleared by:')
      expect(db().query('SELECT status,error FROM landing WHERE branch=?').get('wrong-main-head'))
        .toMatchObject({ status: 'refused', error: expect.stringContaining('other-main-branch') })
      expect(db().query(
        `SELECT resource_kind, event_kind, resource_key FROM contention
          WHERE landing_id=(SELECT id FROM landing WHERE branch='wrong-main-head')`,
      ).get()).toEqual({
        resource_kind: 'trunk', event_kind: 'refusal', resource_key: 'landing-wrong-main-head',
      })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing installs a changed package in the main checkout and records the landed tip', async () => {
    const { repo, trees } = repoWithBranches(['install-package'])
    const tree = trees['install-package']!
    writeFileSync(join(tree, 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}\n')
    g(tree, 'add', 'package.json')
    g(tree, 'commit', '--amend', '--no-edit')
    const fake = join(repo, 'fake-bin')
    mkdirSync(fake)
    writeFileSync(join(fake, 'bun'), `#!/bin/sh\npwd > ${JSON.stringify(join(repo, 'installed-at'))}\n`)
    chmodSync(join(fake, 'bun'), 0o755)
    upsertProject({ name: 'landing-install-package', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'install-package', {}, { PATH: `${fake}:${process.env.PATH}` })
      expect(await child.exited).toBe(0)
      expect(readFileSync(join(repo, 'installed-at'), 'utf8').trim()).toBe(repo)
      expect(db().query('SELECT status,tip,trunk_before FROM landing WHERE branch=?').get('install-package'))
        .toMatchObject({ status: 'landed', tip: g(repo, 'rev-parse', 'main'), trunk_before: expect.any(String) })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an install failure exits non-zero after recording that trunk landed', async () => {
    const { repo, trees } = repoWithBranches(['install-fails'])
    const tree = trees['install-fails']!
    writeFileSync(join(tree, 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}\n')
    g(tree, 'add', 'package.json')
    g(tree, 'commit', '--amend', '--no-edit')
    const fake = join(repo, 'fake-bin')
    mkdirSync(fake)
    writeFileSync(join(fake, 'bun'), '#!/bin/sh\necho install exploded >&2\nexit 7\n')
    chmodSync(join(fake, 'bun'), 0o755)
    upsertProject({ name: 'landing-install-fails', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'install-fails', {}, { PATH: `${fake}:${process.env.PATH}` })
      expect(await child.exited).not.toBe(0)
      expect(g(repo, 'merge-base', '--is-ancestor', 'install-fails', 'main')).toBe('')
      expect(db().query('SELECT status,tip,error FROM landing WHERE branch=?').get('install-fails'))
        .toMatchObject({
          status: 'install_failed', tip: g(repo, 'rev-parse', 'main'),
          error: expect.stringContaining('install exploded'),
        })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing reconciles a clean checkout of trunk to the landed commit', async () => {
    const { repo } = repoWithBranches(['clean-landing'])
    upsertProject({ name: 'landing-clean-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'clean-landing')
      expect(await child.exited).toBe(0)
      const tip = g(repo, 'rev-parse', 'refs/heads/main')
      expect(g(repo, 'rev-parse', 'HEAD')).toBe(tip)
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'clean-landing.txt'), 'utf8')).toBe('clean-landing\n')
      expect(g(repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('nested landing keeps the outer worker guard after land returns or throws', () => {
    for (const outcome of ['returns', 'throws'] as const) {
      const branch = `nested-land-${outcome}`
      const { repo, trees } = repoWithBranches([branch])
      const tree = trees[branch]!
      upsertProject({
        name: `landing-guard-${outcome}`, path: repo,
        settings: { trunk: 'main', gate: outcome === 'returns' ? 'true' : 'false' },
      })
      try {
        const outerGuard = prepareSharedRefGuard(tree, `refs/heads/${branch}`)
        if (outcome === 'returns') {
          expect(() => land(repo, branch, { unreviewed: 'nested landing fixture' })).not.toThrow()
        } else {
          expect(() => land(repo, branch, { unreviewed: 'nested landing fixture' })).toThrow()
        }
        expect(existsSync(join(outerGuard.GIT_CONFIG_VALUE_0, 'reference-transaction'))).toBe(true)
        const forbidden = Bun.spawnSync([
          'git', 'update-ref', 'refs/heads/forbidden-after-land', 'HEAD',
        ], {
          cwd: tree, env: hermeticGitEnv(outerGuard), stdout: 'pipe', stderr: 'pipe',
        })
        expect(forbidden.exitCode).not.toBe(0)
        expect(forbidden.stderr.toString()).toContain('this worker may update only')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  test('landing ignores worker global and system config while retaining the target user config', async () => {
    const { repo } = repoWithBranches(['scrub-config'])
    const workerHooks = join(repo, 'worker-hooks')
    const workerConfig = join(repo, 'worker.gitconfig')
    const targetHome = join(repo, 'target-home')
    mkdirSync(workerHooks)
    mkdirSync(targetHome)
    writeFileSync(join(workerHooks, 'reference-transaction'), '#!/bin/sh\nexit 73\n')
    chmodSync(join(workerHooks, 'reference-transaction'), 0o755)
    writeFileSync(workerConfig, [
      '[core]', `\thooksPath = ${workerHooks}`,
      '[user]', '\tname = Worker Identity', '\temail = worker@example.invalid',
    ].join('\n') + '\n')
    writeFileSync(join(targetHome, '.gitconfig'), [
      '[user]', '\tname = Target Identity', '\temail = target@example.invalid',
    ].join('\n') + '\n')
    g(repo, 'config', '--unset', 'user.name')
    g(repo, 'config', '--unset', 'user.email')
    upsertProject({ name: 'landing-scrub-config', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'scrub-config', {
        message: 'DEV-299 landing with target config',
      }, {
        HOME: targetHome,
        GIT_CONFIG_GLOBAL: workerConfig,
        GIT_CONFIG_SYSTEM: workerConfig,
        GIT_CONFIG_NOSYSTEM: '1',
      })
      const exit = await child.exited
      const error = await new Response(child.stderr).text()
      expect(exit, error).toBe(0)
      expect(g(repo, 'log', '-1', '--format=%cn', 'main')).toBe('Target Identity')
      expect(() => g(repo, 'config', '--get', 'core.hooksPath')).toThrow()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing reconciles around genuine tracked work without changing it', async () => {
    const { repo } = repoWithBranches(['dirty-landing'])
    writeFileSync(join(repo, 'base.txt'), 'work owned by another session\n')
    upsertProject({ name: 'landing-dirty-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'dirty-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      const tip = g(repo, 'rev-parse', 'dirty-landing')
      expect(g(repo, 'rev-parse', 'HEAD')).toBe(tip)
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('work owned by another session\n')
      expect(readFileSync(join(repo, 'dirty-landing.txt'), 'utf8')).toBe('dirty-landing\n')
      expect(g(repo, 'status', '--short')).toBe('M base.txt')
      expect(output).toContain(`reconciled checkout ${repo}`)
      expect(output).not.toContain('CONDITION:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an untracked file neither blocks reconciliation nor enters the index', async () => {
    const { repo } = repoWithBranches(['untracked-landing'])
    writeFileSync(join(repo, 'orch.db.bak-test'), 'litter\n')
    upsertProject({ name: 'landing-untracked-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'untracked-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      const tip = g(repo, 'rev-parse', 'untracked-landing')
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'untracked-landing.txt'), 'utf8')).toBe('untracked-landing\n')
      expect(g(repo, 'status', '--short')).toBe('?? orch.db.bak-test')
      expect(output).toContain(`reconciled checkout ${repo}`)
      expect(output).not.toContain('CONDITION:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a conflicting staged-only version is anchored and recoverable without changing working bytes', async () => {
    const { repo, trees } = repoWithBranches(['staged-landing'])
    writeFileSync(join(trees['staged-landing']!, 'base.txt'), 'landed version\n')
    g(trees['staged-landing']!, 'add', 'base.txt')
    g(trees['staged-landing']!, 'commit', '-m', 'DEV-219 touch staged path')
    writeFileSync(join(repo, 'base.txt'), 'staged version\n')
    g(repo, 'add', 'base.txt')
    const indexBefore = g(repo, 'write-tree')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    const workingBefore = readFileSync(join(repo, 'base.txt'))
    expect(() => g(repo, 'rev-parse', '--verify', 'refs/stash')).toThrow()
    upsertProject({ name: 'landing-staged-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'staged-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      const tip = g(repo, 'rev-parse', 'staged-landing')
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', `${tip}^{tree}`))
      expect(readFileSync(join(repo, 'base.txt'))).toEqual(workingBefore)
      expect(output).toContain('CONDITION: landing succeeded')
      expect(output).toContain('Review and reconcile this checkout before using or committing it.')
      const preserved = output.match(/previous index is preserved at (refs\/orch\/preserved-index\/\S+) \(([0-9a-f]+)\)/)
      expect(preserved).not.toBeNull()
      expect(g(repo, 'rev-parse', preserved![1]!)).toBe(preserved![2]!)
      expect(() => g(repo, 'rev-parse', '--verify', 'refs/stash')).toThrow()
      const command = output.split('\n').find((line) => line.startsWith('git -C '))
      expect(command).toBeDefined()
      const recovery = Bun.spawnSync(['sh', '-lc', command!], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(recovery.exitCode).toBe(0)
      expect(g(repo, 'write-tree')).toBe(indexBefore)
      expect(readFileSync(join(repo, 'base.txt'))).toEqual(workingBefore)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a previously stale and dirty trunk checkout is treated as holding work', async () => {
    const { repo } = repoWithBranches(['prior-landing', 'next-landing'])
    const staleIndex = g(repo, 'write-tree')
    g(repo, 'update-ref', 'refs/heads/main', 'refs/heads/prior-landing', 'HEAD')
    writeFileSync(join(repo, 'base.txt'), 'work in the stale checkout\n')
    upsertProject({ name: 'landing-stale-dirty-checkout', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'next-landing')
      expect(await child.exited).toBe(0)
      const output = (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text())
      expect(g(repo, 'write-tree')).toBe(g(repo, 'rev-parse', 'HEAD^{tree}'))
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('work in the stale checkout\n')
      expect(existsSync(join(repo, 'prior-landing.txt'))).toBe(false)
      expect(existsSync(join(repo, 'next-landing.txt'))).toBe(false)
      expect(output).toContain(`checkout ${repo} could not be reconciled because it holds tracked work`)
      expect(output).toContain('prior-landing.txt')
      expect(output).toContain('base.txt')
      expect(output).toContain('Recover that exact index with:')
      expect(g(repo, 'status', '--short')).toContain(' D prior-landing.txt')
      expect(g(repo, 'status', '--short')).toContain(' D next-landing.txt')
      expect(staleIndex).not.toBe(g(repo, 'write-tree'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('two-tree reconciliation refuses staged work on a touched file', () => {
    const { repo } = repoWithBranches(['read-tree-landing'])
    try {
      const oldTrunk = g(repo, 'rev-parse', 'HEAD')
      const tip = g(repo, 'rev-parse', 'refs/heads/read-tree-landing')
      g(repo, 'update-ref', 'refs/heads/main', tip, oldTrunk)
      writeFileSync(join(repo, 'read-tree-landing.txt'), 'locally staged work\n')
      g(repo, 'add', 'read-tree-landing.txt')
      const indexBefore = g(repo, 'write-tree')

      expect(() => g(repo, 'read-tree', '-m', '-u', oldTrunk, tip)).toThrow()
      expect(g(repo, 'write-tree')).toBe(indexBefore)
      expect(readFileSync(join(repo, 'read-tree-landing.txt'), 'utf8'))
        .toBe('locally staged work\n')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('two simultaneous landings both land and the stale gate is run again', async () => {
    const { repo } = repoWithBranches(['first', 'second'])
    const log = join(repo, 'gate.log')
    const gate = join(repo, 'gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nb=$(git branch --show-current)\nh=$(git rev-parse HEAD)\nprintf '%s %s\\n' "$b" "$h" >> '${log}'\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-pair', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const first = childLand(repo, 'first')
      const second = childLand(repo, 'second')
      expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0])
      const files = g(repo, 'ls-tree', '-r', '--name-only', 'main')
      expect(files).toContain('first.txt')
      expect(files).toContain('second.txt')
      const rows = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      expect(rows.length).toBeGreaterThanOrEqual(2)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a gate failure under the lock releases it for a waiting landing', async () => {
    const { repo } = repoWithBranches(['fails', 'waits'])
    const gate = join(repo, 'gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nb=$(git branch --show-current)\nif [ "$b" = fails ]; then\n c='${repo}/fails-count'; n=0; [ ! -e "$c" ] || n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"\n if [ "$n" = 1 ]; then touch '${repo}/first-gate'; while [ ! -e '${repo}/trunk-moved' ]; do sleep 0.01; done\n else touch '${repo}/failing-under-lock'; sleep 0.15; exit 7; fi\nfi\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-failure', path: repo, settings: { trunk: 'main', gate } })
    try {
      const failing = childLand(repo, 'fails')
      for (let i = 0; i < 200 && !existsSync(join(repo, 'first-gate')); i++) await Bun.sleep(5)
      writeFileSync(join(repo, 'trunk.txt'), 'moved\n')
      g(repo, 'add', 'trunk.txt')
      g(repo, 'commit', '-m', 'move trunk')
      writeFileSync(join(repo, 'trunk-moved'), '')
      for (let i = 0; i < 200 && !existsSync(join(repo, 'failing-under-lock')); i++) await Bun.sleep(5)
      const waiting = childLand(repo, 'waits')
      expect(await failing.exited).not.toBe(0)
      expect(await waiting.exited).toBe(0)
      expect(g(repo, 'show', 'main:waits.txt')).toBe('waits')
      expect(projectLockState(repo, 'landing').holder).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  }, 15_000)

  test('a killed holder releases its kernel lock, and another project never waits on it', async () => {
    const one = repoWithBranches([]).repo
    const two = repoWithBranches([]).repo
    const hold = `const { withProjectLock } = await import(process.argv[1]); ` +
      `withProjectLock(process.argv[2], 'landing', {session:'dead-session',what:'dead-branch'}, ` +
      `() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000), 1000, true)`
    const child = Bun.spawn([process.execPath, '-e', hold, worktreeModule, one], {
      env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe',
    })
    try {
      for (let i = 0; i < 200 && !projectLockState(one, 'landing').holder; i++) await Bun.sleep(5)
      expect(projectLockState(one, 'landing').holder?.what).toBe('dead-branch')
      const started = Date.now()
      expect(withProjectLock(two, 'landing', { session: 'other', what: 'other-branch' }, () => 'ok', LOCK_TIMEOUT_MS, true)).toBe('ok')
      expect(Date.now() - started).toBeLessThan(ELAPSED_MS)
      child.kill('SIGKILL')
      await child.exited
      expect(withProjectLock(one, 'landing', { session: 'next', what: 'next-branch' }, () => 'acquired', 500, true)).toBe('acquired')
    } finally {
      child.kill()
      await child.exited
      rmSync(one, { recursive: true, force: true })
      rmSync(two, { recursive: true, force: true })
    }
  }, 30_000)

  test('self-contention refuses within one second and names the owned landing', async () => {
    const branch = 'self-contention'
    const { repo } = repoWithBranches([branch])
    const ready = join(repo, 'holder-ready')
    const release = join(repo, 'holder-release')
    upsertProject({ name: 'landing-self-contention', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    const holder = Bun.spawn([
      process.execPath, '-e',
      `const{existsSync,writeFileSync}=await import('node:fs');const{withProjectLock}=await import(process.argv[1]);withProjectLock(process.argv[2],'landing',{session:process.argv[3],what:process.argv[3]},()=>{writeFileSync(process.argv[4],'');while(!existsSync(process.argv[5]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)},5000,true)`,
      worktreeModule, repo, branch, ready, release,
    ], { env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    try {
      for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5)
      const started = Date.now()
      const child = childLand(repo, branch)
      expect(await child.exited).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(1_000)
      const error = await new Response(child.stderr).text()
      expect(error).toContain(`your own landing ${holder.pid}, branch ${branch}, started `)
    } finally {
      writeFileSync(release, '')
      await holder.exited
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a project with no declared gate is refused before it can land', async () => {
    const { repo } = repoWithBranches(['ungated'])
    upsertProject({ name: 'landing-ungated', path: repo, settings: { trunk: 'main' } })
    try {
      const child = childLand(repo, 'ungated')
      expect(await child.exited).not.toBe(0)
      expect((await new Response(child.stderr).text())).toContain(
        'project landing-ungated has no landing gate configured',
      )
      expect(() => g(repo, 'merge-base', '--is-ancestor', 'ungated', 'main')).toThrow()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  for (const refusal of ['authorization', 'gate'] as const) {
    test(`${refusal} refusal after checkpoint squash restores the original tip and index`, async () => {
      const branch = `checkpoint-${refusal}`
      const { repo, trees } = repoWithBranches([branch])
      const tree = trees[branch]!
      writeFileSync(join(tree, `${branch}.txt`), 'checkpoint delta\n')
      g(tree, 'add', `${branch}.txt`)
      g(tree, 'commit', '-m', `DEV-374 checkpoint run 99 #1`)
      writeFileSync(join(tree, 'authored.txt'), 'authored delta\n')
      g(tree, 'add', 'authored.txt')
      g(tree, 'commit', '-m', 'DEV-374 authored work')
      const before = g(tree, 'rev-parse', 'HEAD')
      const indexBefore = g(tree, 'write-tree')
      upsertProject({ name: `landing-${branch}`, path: repo,
        settings: { trunk: 'main', gate: refusal === 'gate' ? 'false' : 'true' } })
      try {
        const child = childLand(repo, branch, refusal === 'authorization' ? { unreviewed: null } : {})
        expect(await child.exited).not.toBe(0)
        expect(g(tree, 'rev-parse', 'HEAD')).toBe(before)
        expect(g(repo, 'rev-parse', branch)).toBe(before)
        expect(g(tree, 'write-tree')).toBe(indexBefore)
        const error = await new Response(child.stderr).text()
        if (refusal === 'authorization') {
          // Unreviewed content is refused at enqueue, before any squash runs.
          expect(error).toContain('refusing to land unreviewed content')
          expect(error).not.toContain('restored branch tip')
        } else {
          expect(error).toContain(`restored branch tip ${before}`)
          expect(error).toContain('index to the pre-squash state')
        }
      } finally { rmSync(repo, { recursive: true, force: true }) }
    })
  }

  test('a buried coloured bun timeout failure is repeated with machine load and complete output path', async () => {
    const { repo } = repoWithBranches(['timeout-summary'])
    const name = 'deeply buried coloured timeout test'
    const timeout = realTimeoutGate(name)
    upsertProject({ name: 'landing-timeout-summary', path: repo,
      settings: { trunk: 'main', gate: timeout.gate } })
    addRun({ agent: 'codex', job: 'implement', status: 'running' })
    addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    try {
      const child = childLand(repo, 'timeout-summary', {}, {
        NO_COLOR: undefined,
        FORCE_COLOR: '1',
      })
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error).toContain(`✗ ${name}`)
      expect(error).toContain('1 fail')
      expect(error).toContain(
        'gate timeout under load: 2 orch runs live (running + asking) machine-wide',
      )
      expect(db().query(
        "SELECT resource_kind, event_kind, resource_key FROM contention WHERE resource_kind='cpu'",
      ).get()).toEqual({
        resource_kind: 'cpu', event_kind: 'timeout', resource_key: 'landing-timeout-summary',
      })
      const outputPath = error.match(/complete gate output: (.+\/output\.log)/)?.[1]
      expect(outputPath).toBeDefined()
      expect(readdirSync(dirname(outputPath!))).toEqual(['output.log'])
      const complete = readFileSync(outputPath!, 'utf8')
      expect(complete).toContain('✗')
      expect(complete).toContain(name)
      expect(complete).toContain('\x1b[')
      expect(complete).toContain('900 pass')
      expect(complete).toContain('1 fail')
      rmSync(dirname(outputPath!), { recursive: true, force: true })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(timeout.fixture, { recursive: true, force: true })
    }
  })

  test('a buried NO_COLOR bun timeout failure keeps the alternate reporter name', async () => {
    const { repo } = repoWithBranches(['timeout-no-color'])
    const name = 'deeply buried no-colour timeout test'
    const timeout = realTimeoutGate(name)
    upsertProject({ name: 'landing-timeout-no-color', path: repo,
      settings: { trunk: 'main', gate: timeout.gate } })
    try {
      const child = childLand(repo, 'timeout-no-color', {}, {
        FORCE_COLOR: undefined,
        CLICOLOR: undefined,
        CLICOLOR_FORCE: undefined,
        NO_COLOR: '1',
      })
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error).toContain(`(fail) ${name}`)
      expect(error).toContain('1 fail')
      expect(error).toContain('gate timeout under load: 0 orch runs live (running + asking) machine-wide')
      const outputPath = error.match(/complete gate output: (.+\/output\.log)/)?.[1]
      expect(outputPath).toBeDefined()
      const complete = readFileSync(outputPath!, 'utf8')
      expect(complete).toContain(`(fail) ${name}`)
      expect(complete).not.toContain('\x1b[')
      expect(complete).toContain('900 pass')
      expect(complete).toContain('1 fail')
      rmSync(dirname(outputPath!), { recursive: true, force: true })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(timeout.fixture, { recursive: true, force: true })
    }
  })

  test('a failed gate with a leaked fifo writer names its truncated capture', async () => {
    const { repo } = repoWithBranches(['leaked-gate-writer'])
    const sleeperPid = join(repo, 'leaked-gate-writer.pid')
    const gate = join(repo, 'leaked-gate-writer.sh')
    writeFileSync(gate, `#!/bin/sh\nsleep 60 &\necho $! > "${sleeperPid}"\nexit 7\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-leaked-gate-writer', path: repo,
      settings: { trunk: 'main', gate } })
    const started = Date.now()
    try {
      const child = childLand(repo, 'leaked-gate-writer')
      const exit = await child.exited
      const error = await new Response(child.stderr).text()
      expect(exit).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(8_000)
      expect(error).toContain(
        'gate output (TRUNCATED after 5 s: a process the gate left behind still held its output pipe):',
      )
      const outputPath = error.match(/output pipe\): (.+\/output\.log)/)?.[1]
      expect(outputPath).toBeDefined()
      rmSync(dirname(outputPath!), { recursive: true, force: true })
    } finally {
      if (existsSync(sleeperPid)) {
        try { process.kill(Number(readFileSync(sleeperPid, 'utf8').trim()), 'SIGKILL') } catch {}
      }
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('a successful gate with a leaked fifo writer still lands', async () => {
    const { repo } = repoWithBranches(['successful-leaked-gate-writer'])
    const sleeperPid = join(repo, 'successful-leaked-gate-writer.pid')
    const gate = join(repo, 'successful-leaked-gate-writer.sh')
    writeFileSync(gate, `#!/bin/sh\nsleep 60 &\necho $! > "${sleeperPid}"\nexit 0\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-successful-leaked-gate-writer', path: repo,
      settings: { trunk: 'main', gate } })
    const started = Date.now()
    try {
      const child = childLand(repo, 'successful-leaked-gate-writer')
      const exit = await child.exited
      const error = await new Response(child.stderr).text()
      expect(exit, error).toBe(0)
      expect(Date.now() - started).toBeLessThan(8_000)
      expect(g(repo, 'rev-parse', 'main'))
        .toBe(g(repo, 'rev-parse', 'successful-leaked-gate-writer'))
    } finally {
      if (existsSync(sleeperPid)) {
        try { process.kill(Number(readFileSync(sleeperPid, 'utf8').trim()), 'SIGKILL') } catch {}
      }
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('a failing test name printed after capture truncation is not claimed as captured', async () => {
    const { repo } = repoWithBranches(['late-gate-writer'])
    const writerPid = join(repo, 'late-gate-writer.pid')
    const gate = join(repo, 'late-gate-writer.sh')
    writeFileSync(gate,
      `#!/bin/sh\n(sleep 6; echo '(fail) too-late test') &\necho $! > "${writerPid}"\nexit 7\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-late-gate-writer', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const child = childLand(repo, 'late-gate-writer')
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error).toContain('gate output (TRUNCATED after 5 s:')
      expect(error).toContain('gate failures:\nno failing test named in the captured output')
      expect(error).not.toContain('too-late test')
      const outputPath = error.match(/output pipe\): (.+\/output\.log)/)?.[1]
      expect(outputPath).toBeDefined()
      rmSync(dirname(outputPath!), { recursive: true, force: true })
    } finally {
      if (existsSync(writerPid)) {
        try { process.kill(Number(readFileSync(writerPid, 'utf8').trim()), 'SIGKILL') } catch {}
      }
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('a capture setup failure runs the original gate and reports uncaptured output', async () => {
    const { repo } = repoWithBranches(['capture-setup-failure'])
    const marker = join(repo, 'gate-ran')
    const gate = join(repo, 'capture-setup-failure.sh')
    const bin = join(repo, 'capture-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'mkfifo'), '#!/bin/sh\necho fixture mkfifo refusal >&2\nexit 9\n')
    chmodSync(join(bin, 'mkfifo'), 0o755)
    writeFileSync(gate, `#!/bin/sh\ntouch "${marker}"\nexit 7\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-capture-setup-failure', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const child = childLand(repo, 'capture-setup-failure', {}, {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      })
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(existsSync(marker)).toBe(true)
      expect(error).toContain(`landing gate failed with exit 7: ${gate}`)
      expect(error).toContain('gate output not captured: fixture mkfifo refusal')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  for (const [name, command] of [
    ['commits', `printf 'gate commit\\n' > gate-change.txt && git add gate-change.txt && git commit -m 'gate commit'`],
    ['amends', `git commit --amend -m 'gate amended'`],
    ['checks out another ref', `git checkout --detach main`],
  ] as const) {
    test(`refuses when the gate ${name} and names both HEAD OIDs`, async () => {
      const branch = `gate-${name.replaceAll(' ', '-')}`
      const { repo, trees } = repoWithBranches([branch])
      const gate = join(repo, `${branch}.sh`)
      writeFileSync(gate, `#!/bin/sh\nset -eu\n${command}\n`)
      chmodSync(gate, 0o755)
      upsertProject({ name: `landing-${branch}`, path: repo,
        settings: { trunk: 'main', gate } })
      try {
        const before = g(trees[branch]!, 'rev-parse', 'HEAD')
        const trunk = g(repo, 'rev-parse', 'main')
        const child = childLand(repo, branch)
        expect(await child.exited).not.toBe(0)
        const after = g(trees[branch]!, 'rev-parse', 'HEAD')
        const error = await new Response(child.stderr).text()
        expect(after).toBe(before)
        expect(error).toContain(gate)
        expect(error).toContain(before)
        expect(error).toContain(`moved HEAD from ${before} to `)
        expect(error).toContain('restored branch tip')
        expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
      } finally { rmSync(repo, { recursive: true, force: true }) }
    })
  }

  test('refuses when the gate moves only the landing branch ref and names both OIDs', async () => {
    const branch = 'gate-moves-branch-ref'
    const { repo, trees } = repoWithBranches([branch])
    const gate = join(repo, 'move-branch-ref.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\ngit checkout --detach\ngit update-ref refs/heads/${branch} refs/heads/main\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-moved-branch-ref', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const before = g(trees[branch]!, 'rev-parse', 'HEAD')
      const moved = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, branch)
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(g(trees[branch]!, 'rev-parse', 'HEAD')).toBe(before)
      expect(g(repo, 'rev-parse', branch)).toBe(before)
      expect(error).toContain(gate)
      expect(error).toContain(before)
      expect(error).toContain(moved)
      expect(error).toContain('restored branch tip')
      expect(g(repo, 'rev-parse', 'main')).toBe(moved)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a gate that checks out another tree and restores HEAD, naming new reflog entries', async () => {
    const branch = 'gate-restores-head'
    const { repo, trees } = repoWithBranches([branch])
    const exercised = join(repo, 'exercised-tree')
    const gate = join(repo, 'restore-head.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\ncandidate=$(git rev-parse HEAD)\ngit checkout --detach main\ngit rev-parse HEAD^{tree} > '${exercised}'\ngit reset --hard "$candidate"\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-restored-head', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const candidate = g(trees[branch]!, 'rev-parse', 'HEAD')
      const candidateTree = g(trees[branch]!, 'rev-parse', 'HEAD^{tree}')
      const trunk = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, branch)
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(g(trees[branch]!, 'rev-parse', 'HEAD')).toBe(candidate)
      expect(readFileSync(exercised, 'utf8').trim()).not.toBe(candidateTree)
      expect(error).toContain(gate)
      expect(error).toContain('HEAD reflog:')
      expect(error).toContain('checkout: moving from')
      expect(error).toContain(`reset: moving to ${candidate}`)
      expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a gate that moves the branch away and back, naming its new reflog entries', async () => {
    const branch = 'gate-restores-branch-ref'
    const { repo, trees } = repoWithBranches([branch])
    const gate = join(repo, 'restore-branch-ref.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\ncandidate=$(git rev-parse HEAD)\ngit update-ref -m 'gate branch away' refs/heads/${branch} refs/heads/main\ngit update-ref -m 'gate branch back' refs/heads/${branch} "$candidate"\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-restored-branch-ref', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const candidate = g(trees[branch]!, 'rev-parse', 'HEAD')
      const trunk = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, branch)
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(g(trees[branch]!, 'rev-parse', 'HEAD')).toBe(candidate)
      expect(g(repo, 'rev-parse', branch)).toBe(candidate)
      expect(error).toContain(gate)
      expect(error).toContain(`refs/heads/${branch} reflog:`)
      expect(error).toContain(candidate)
      expect(error).toContain(trunk)
      expect(error).toContain('gate branch away')
      expect(error).toContain('gate branch back')
      expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses an away-and-back gate that shortens the reflogs', async () => {
    const branch = 'gate-shortens-reflogs'
    const { repo, trees } = repoWithBranches([branch])
    const exercised = join(repo, 'shortened-exercised-tree')
    const gate = join(repo, 'shorten-reflogs.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\ncandidate=$(git rev-parse HEAD)\ngit checkout --detach main\ngit rev-parse HEAD^{tree} > '${exercised}'\ngit reset --hard "$candidate"\ngit reflog expire --expire=now --all\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-shortened-reflogs', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const candidate = g(trees[branch]!, 'rev-parse', 'HEAD')
      const candidateTree = g(trees[branch]!, 'rev-parse', 'HEAD^{tree}')
      const trunk = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, branch)
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(g(trees[branch]!, 'rev-parse', 'HEAD')).toBe(candidate)
      expect(readFileSync(exercised, 'utf8').trim()).not.toBe(candidateTree)
      expect(error).toContain(gate)
      expect(error).toContain('HEAD reflog:')
      expect(error).toContain('missing:')
      expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a same-OID reset reflog entry is a no-op and still lands', async () => {
    const branch = 'gate-soft-reset'
    const { repo } = repoWithBranches([branch])
    const gate = join(repo, 'soft-reset.sh')
    writeFileSync(gate, '#!/bin/sh\nset -eu\ngit reset --soft HEAD\n')
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-soft-reset', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const candidate = g(repo, 'rev-parse', branch)
      const child = childLand(repo, branch)
      expect(await child.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(candidate)
      expect(g(repo, 'rev-parse', branch)).toBe(candidate)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses final content hidden from ordinary status and names both content trees', async () => {
    const branch = 'gate-hides-content'
    const { repo, trees } = repoWithBranches([branch])
    const path = `${branch}.txt`
    const gate = join(repo, 'hide-content.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\ngit update-index --assume-unchanged '${path}'\nprintf 'hidden gate change\\n' > '${path}'\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-hidden-content', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const before = contentTree(trees[branch]!)
      const trunk = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, branch)
      expect(await child.exited).not.toBe(0)
      const after = contentTree(trees[branch]!)
      const error = await new Response(child.stderr).text()
      expect(g(trees[branch]!, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')
      expect(after).toBe(before)
      expect(error).toContain(gate)
      expect(error).toContain(before)
      expect(error).toContain('changed the content tree from')
      expect(error).toContain('restored branch tip')
      expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a gate that does not move HEAD or the landing branch still lands', async () => {
    const branch = 'gate-does-not-move'
    const { repo } = repoWithBranches([branch])
    const gate = join(repo, 'no-move.sh')
    writeFileSync(gate, '#!/bin/sh\nset -eu\ngit rev-parse HEAD >/dev/null\n')
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-no-move', path: repo,
      settings: { trunk: 'main', gate } })
    try {
      const child = childLand(repo, branch)
      expect(await child.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', branch))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a green landing with no completed review and names the candidate tree', async () => {
    const { repo, trees } = repoWithBranches(['unreviewed'])
    upsertProject({ name: 'landing-unreviewed', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const tree = g(trees.unreviewed!, 'rev-parse', 'HEAD^{tree}')
      const trunk = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, 'unreviewed', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error).toContain(`candidate tree: ${tree}`)
      expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a stale branch review yields bounded coverage output without unrelated rerun directives', async () => {
    const branch = 'bounded-review-output'
    const { repo, trees } = repoWithBranches([branch])
    const project = 'landing-bounded-review-output'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      completedReview(project, [g(repo, 'rev-parse', `${branch}^{tree}`)], {
        branch, baseCommit: oldBase, launchCwd: trees[branch]!,
      })
      for (let i = 0; i < 100; i++) {
        const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'test',
          lens: `missing-catalogue-${i}`, repo: project })
        db().query('UPDATE run SET branch=? WHERE id=?').run(`other-${i}`, runId)
        const reviewId = (db().query(
          "INSERT INTO review (recorded_at,completed_at) VALUES ('now','now') RETURNING id",
        ).get() as { id: number }).id
        db().query(
          `INSERT INTO review_lens
             (review_id,run_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
           VALUES (?,?,?,?,?,'[]','[]','[]','[]')`,
        ).run(reviewId, runId, `missing-catalogue-${i}`, 'codex', 'test')
      }
      writeFileSync(join(trees[branch]!, 'after-review.txt'), 'new content\n')
      g(trees[branch]!, 'add', 'after-review.txt')
      g(trees[branch]!, 'commit', '-m', 'change after review')

      const child = childLand(repo, branch, { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error.length).toBeLessThan(2_000)
      expect(error).toContain('lenses present: none')
      expect(error).toContain('lenses missing: lens-1')
      expect(error).toContain('review data problems: 101 (example:')
      expect(error).not.toContain('other-99')
      expect(error).not.toContain('--lens missing-catalogue-')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('lands when every lens in a completed review measured the candidate tree', async () => {
    const { repo, trees } = repoWithBranches(['reviewed'])
    const project = 'landing-reviewed'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const tree = g(trees.reviewed!, 'rev-parse', 'HEAD^{tree}')
      completedReview(project, [tree, tree], {
        branch: 'reviewed', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees.reviewed!,
      })
      expect(landingReviewCoverage(trees.reviewed!)).toContain('lenses present: lens-1, lens-2')
      const child = childLand(repo, 'reviewed', { unreviewed: null })
      expect(await child.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', 'reviewed'))
      expect(db().query(
        'SELECT id FROM landing_review_carry WHERE branch=?',
      ).get('reviewed')).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a tree-plus-base-commit review counts as coverage without a stored patch identity', async () => {
    const branch = 'legacy-tree-base-review'
    const { repo, trees } = repoWithBranches([branch])
    const project = 'landing-legacy-tree-base-review'
    const reviewId = completedReview(project, [g(repo, 'rev-parse', `${branch}^{tree}`)], {
      branch, baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees[branch]!,
    })
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      expect(db().query('SELECT patch_id, path_set FROM review WHERE id=?').get(reviewId))
        .toEqual({ patch_id: null, path_set: null })
      writeFileSync(join(repo, 'unrelated-trunk.txt'), 'trunk only\n')
      g(repo, 'add', 'unrelated-trunk.txt')
      g(repo, 'commit', '-m', 'unrelated trunk move')
      g(trees[branch]!, 'rebase', 'main')
      g(trees[branch]!, 'update-ref', '-d', 'AUTO_MERGE')
      const child = childLand(repo, branch, { unreviewed: null })
      expect(await child.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', branch))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('carries a message-only amendment across an unrelated trunk move as no-code-change', async () => {
    const { repo, trees } = repoWithBranches(['carry-review'])
    const project = 'landing-carry-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      writeFileSync(join(trees['carry-review']!, 'second.txt'), 'second commit\n')
      g(trees['carry-review']!, 'add', 'second.txt')
      g(trees['carry-review']!, 'commit', '-m', 'second branch message')
      const reviewedCommit = g(repo, 'rev-parse', 'carry-review')
      const reviewedTree = g(repo, 'rev-parse', 'carry-review^{tree}')
      const reviewId = completedReview(project, [reviewedTree], {
        branch: 'carry-review', baseCommit: oldBase, launchCwd: trees['carry-review']!,
      })
      expect(g(repo, 'rev-parse', `refs/orch/reviewed/${
        (db().query('SELECT run_id FROM review_lens WHERE review_id=?').get(reviewId) as { run_id: number }).run_id
      }`)).toBe(reviewedCommit)
      const earlier = g(repo, 'rev-parse', `${reviewedCommit}^`)
      const amendedEarlier = g(repo, 'commit-tree', `${earlier}^{tree}`, '-p', oldBase,
        '-m', 'amended earlier message')
      const rewrittenTip = g(repo, 'commit-tree', `${reviewedCommit}^{tree}`, '-p', amendedEarlier,
        '-m', 'second branch message')
      g(repo, 'update-ref', 'refs/heads/carry-review', rewrittenTip, reviewedCommit)
      writeFileSync(join(repo, 'unrelated.txt'), 'trunk only\n')
      g(repo, 'add', 'unrelated.txt')
      g(repo, 'commit', '-m', 'unrelated trunk move')
      const newBase = g(repo, 'rev-parse', 'main')
      g(trees['carry-review']!, 'rebase', 'main')
      // This fixture owns the completed rebase, so it may clear the AUTO_MERGE
      // pseudo-ref that git 2.50 leaves behind after the child has exited.
      g(trees['carry-review']!, 'update-ref', '-d', 'AUTO_MERGE')
      g(repo, 'reflog', 'expire', '--expire=now', '--all')
      const beforeLandStatus = landingReviewCoverage(trees['carry-review']!)
      expect(beforeLandStatus).toContain(`review ${reviewId}: carried (patch-id `)
      expect(beforeLandStatus).toContain('class no-code-change')
      expect(listReviews({ project }).find((review) => review.id === reviewId)?.coverage)
        .toBe('no-code-change')
      expect(getReview(reviewId).current_class).toBe('no-code-change')
      expect(beforeLandStatus).toContain('(commit from pin)')
      expect(beforeLandStatus).toContain(`${oldBase}..${newBase})`)
      const child = childLand(repo, 'carry-review', { unreviewed: null })
      expect(await child.exited).toBe(0)
      const stdout = await new Response(child.stdout).text()
      const row = db().query(
        `SELECT project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,
                old_base,new_base
           FROM landing_review_carry WHERE branch=?`,
      ).get('carry-review') as Record<string, string | number>
      expect(row).toEqual({
        project, branch: 'carry-review', tip: g(repo, 'rev-parse', 'carry-review'),
        tree: g(repo, 'rev-parse', 'carry-review^{tree}'), review_id: reviewId,
        reviewed_commit: reviewedCommit, reviewed_tree: reviewedTree,
        patch_id: expect.stringMatching(/^[0-9a-f]{40}$/), old_base: oldBase, new_base: newBase,
      })
      expect(stdout).toContain(
        `review ${reviewId} carried: patch-id ${row.patch_id} unchanged across rebase ` +
        `${oldBase}..${newBase}; gate green on ${row.tip}`,
      )
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a mixed old and new lens set carries from the agreeing non-null pin', () => {
    const { repo, trees } = repoWithBranches(['mixed-pin-review'])
    const project = 'landing-mixed-pin-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const commit = g(repo, 'rev-parse', 'mixed-pin-review')
      const tree = g(repo, 'rev-parse', 'mixed-pin-review^{tree}')
      const entries = [
        addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'new', repo: project,
          inputTree: tree, headCommit: commit }),
        addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'old', repo: project,
          inputTree: tree }),
      ]
      for (const runId of entries) db().query(
        'UPDATE run SET branch=?, base_commit=?, launch_cwd=? WHERE id=?',
      ).run('mixed-pin-review', oldBase, trees['mixed-pin-review']!, runId)
      const reviewId = recordReviews(entries.map((runId) => ({ runId, output: reviewReply(0) })))
      completeReview(reviewId)
      writeFileSync(join(repo, 'mixed-pin-trunk.txt'), 'unrelated\n')
      g(repo, 'add', 'mixed-pin-trunk.txt')
      g(repo, 'commit', '-m', 'move trunk')
      g(trees['mixed-pin-review']!, 'rebase', 'main')
      expect(landingReviewCoverage(trees['mixed-pin-review']!)).toContain(
        `review ${reviewId}: carried (patch-id`,
      )
      expect(landingReviewCoverage(trees['mixed-pin-review']!)).toContain('(commit from pin)')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an all-null legacy lens set carries from the existing commit walk', () => {
    const { repo, trees } = repoWithBranches(['walk-review'])
    const project = 'landing-walk-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const tree = g(repo, 'rev-parse', 'walk-review^{tree}')
      const reviewId = completedReview(project, [tree], {
        branch: 'walk-review', baseCommit: oldBase, launchCwd: trees['walk-review']!,
      })
      const runId = (db().query('SELECT run_id FROM review_lens WHERE review_id=?').get(reviewId) as
        { run_id: number }).run_id
      g(repo, 'update-ref', '-d', `refs/orch/reviewed/${runId}`)
      db().query('UPDATE run SET head_commit=NULL WHERE id=?').run(runId)
      writeFileSync(join(repo, 'walk-trunk.txt'), 'unrelated\n')
      g(repo, 'add', 'walk-trunk.txt')
      g(repo, 'commit', '-m', 'move trunk')
      g(trees['walk-review']!, 'rebase', 'main')
      const status = landingReviewCoverage(trees['walk-review']!)
      expect(status).toContain(`review ${reviewId}: carried (patch-id`)
      expect(status).toContain('(commit from walk)')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('review pins prune only completed reviews whose branch has landed', () => {
    const { repo, trees } = repoWithBranches(['pin-prune'])
    const project = 'landing-pin-prune'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const commit = g(repo, 'rev-parse', 'pin-prune')
      const tree = g(repo, 'rev-parse', 'pin-prune^{tree}')
      const completed = completedReview(project, [tree], {
        branch: 'pin-prune', baseCommit: oldBase, launchCwd: trees['pin-prune']!,
      })
      const incompleteRun = addRun({
        agent: 'codex', job: 'review-lens', model: 'test', lens: 'incomplete', repo: project,
        inputTree: tree, headCommit: commit,
      })
      db().query('UPDATE run SET branch=?, base_commit=?, launch_cwd=? WHERE id=?')
        .run('pin-prune', oldBase, trees['pin-prune']!, incompleteRun)
      const incomplete = recordReviews([{ runId: incompleteRun, output: reviewReply(0) }])

      expect(reviewPins(true).map((pin) => ({ review: pin.reviewId, deleted: pin.deleted })))
        .toEqual([
          { review: completed, deleted: false },
          { review: incomplete, deleted: false },
        ])
      g(repo, 'update-ref', 'refs/heads/main', 'refs/heads/pin-prune')
      const pruned = reviewPins(true)
      expect(pruned.find((pin) => pin.reviewId === completed)?.deleted).toBe(true)
      expect(pruned.find((pin) => pin.reviewId === incomplete)?.deleted).toBe(false)
      expect(() => g(repo, 'rev-parse', `refs/orch/reviewed/${incompleteRun}`)).not.toThrow()
      const completedRun = (db().query(
        'SELECT run_id FROM review_lens WHERE review_id=?',
      ).get(completed) as { run_id: number }).run_id
      expect(() => g(repo, 'rev-parse', `refs/orch/reviewed/${completedRun}`)).toThrow()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('discard and sweep leave reviewed-commit pins intact', () => {
    for (const command of ['discard', 'sweep'] as const) {
      const branch = `pin-${command}`
      const { repo, trees } = repoWithBranches([branch])
      const project = `landing-${branch}`
      upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
      try {
        const reviewId = completedReview(project, [g(repo, 'rev-parse', `${branch}^{tree}`)], {
          branch, baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees[branch]!,
        })
        const runId = (db().query(
          'SELECT run_id FROM review_lens WHERE review_id=?',
        ).get(reviewId) as { run_id: number }).run_id
        const ref = `refs/orch/reviewed/${runId}`
        const pinned = g(repo, 'rev-parse', ref)
        db().query(
          `UPDATE run SET worktree=?, worktree_source='git',
                          started_at='2020-01-01T00:00:00.000Z' WHERE id=?`,
        )
          .run(trees[branch]!, runId)
        const args = command === 'discard'
          ? ['discard', String(runId), '--force']
          : ['sweep', '--older-than', '0', '--force']
        const result = Bun.spawnSync([
          process.execPath, new URL('cli.ts', import.meta.url).pathname, ...args,
        ], {
          cwd: repo,
          env: {
            ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'review-pin-owner',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode).toBe(command === 'discard' ? 0 : 1)
        expect(g(repo, 'rev-parse', ref)).toBe(pinned)
      } finally { rmSync(repo, { recursive: true, force: true }) }
    }
  })

  test('refuses a carry when trunk moved on a path touched by the change', async () => {
    const { repo, trees } = repoWithBranches(['overlap-review'])
    const project = 'landing-overlap-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      writeFileSync(join(repo, 'shared.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(''))
      g(repo, 'add', 'shared.txt')
      g(repo, 'commit', '-m', 'shared base')
      g(trees['overlap-review']!, 'rebase', 'main')
      const oldBase = g(repo, 'rev-parse', 'main')
      const branchPath = join(trees['overlap-review']!, 'shared.txt')
      const branchLines = readFileSync(branchPath, 'utf8').split('\n')
      branchLines[1] = 'branch line'
      writeFileSync(branchPath, branchLines.join('\n'))
      g(trees['overlap-review']!, 'add', 'shared.txt')
      g(trees['overlap-review']!, 'commit', '-m', 'branch shared change')
      const reviewedTree = g(repo, 'rev-parse', 'overlap-review^{tree}')
      completedReview(project, [reviewedTree], {
        branch: 'overlap-review', baseCommit: oldBase, launchCwd: trees['overlap-review']!,
      })
      const trunkLines = readFileSync(join(repo, 'shared.txt'), 'utf8').split('\n')
      trunkLines[18] = 'trunk line'
      writeFileSync(join(repo, 'shared.txt'), trunkLines.join('\n'))
      g(repo, 'add', 'shared.txt')
      g(repo, 'commit', '-m', 'trunk shared change')
      const child = childLand(repo, 'overlap-review', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('overlapping paths: shared.txt')
      expect(db().query('SELECT outdated_at, outdated_reason FROM review ORDER BY id DESC LIMIT 1').get())
        .toEqual({ outdated_at: null, outdated_reason: null })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an unrelated branch review cannot invalidate otherwise-valid coverage', async () => {
    const { repo, trees } = repoWithBranches(['candidate-review', 'unrelated-review'])
    const project = 'landing-unrelated-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      completedReview(project, [g(repo, 'rev-parse', 'unrelated-review^{tree}')], {
        branch: 'unrelated-review', baseCommit: oldBase, launchCwd: trees['unrelated-review']!,
      })
      completedReview(project, [g(repo, 'rev-parse', 'candidate-review^{tree}')], {
        branch: 'candidate-review', baseCommit: oldBase, launchCwd: trees['candidate-review']!,
      })
      writeFileSync(join(repo, 'trunk-only.txt'), 'trunk only\n')
      g(repo, 'add', 'trunk-only.txt')
      g(repo, 'commit', '-m', 'move trunk')
      g(trees['candidate-review']!, 'rebase', 'main')
      g(trees['candidate-review']!, 'update-ref', '-d', 'AUTO_MERGE')

      const child = childLand(repo, 'candidate-review', { unreviewed: null })
      expect(await child.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', 'candidate-review'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a carry when the branch gained content after review', async () => {
    const { repo, trees } = repoWithBranches(['changed-review'])
    const project = 'landing-changed-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedCommit = g(repo, 'rev-parse', 'changed-review')
      const reviewedTree = g(repo, 'rev-parse', 'changed-review^{tree}')
      completedReview(project, [reviewedTree], {
        branch: 'changed-review', baseCommit: oldBase, launchCwd: trees['changed-review']!,
      })
      writeFileSync(join(trees['changed-review']!, 'after-review.txt'), 'new content\n')
      g(trees['changed-review']!, 'add', 'after-review.txt')
      g(trees['changed-review']!, 'commit', '-m', 'content after review')
      expect(landingReviewCoverage(trees['changed-review']!)).toContain('lenses missing: lens-1')
      const child = childLand(repo, 'changed-review', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      const stderr = await new Response(child.stderr).text()
      expect(stderr).toContain('1 review not evidence (example: review')
      expect(stderr).toContain('patch-id differs')
      expect(stderr).toContain('lenses missing: lens-1')
      expect(db().query('SELECT outdated_at, outdated_reason FROM review ORDER BY id DESC LIMIT 1').get())
        .toEqual({ outdated_at: expect.any(String), outdated_reason: 'patch-id differs' })
      g(trees['changed-review']!, 'reset', '--hard', reviewedCommit)
      const exact = childLand(repo, 'changed-review', { unreviewed: null })
      expect(await exact.exited).toBe(0)
      expect(db().query('SELECT outdated_at, outdated_reason FROM review ORDER BY id DESC LIMIT 1').get())
        .toEqual({ outdated_at: null, outdated_reason: null })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test("a refused landing outdates only the candidate branch's review", async () => {
    const parent = 'parent-review'
    const candidate = 'candidate-review'
    const { repo, trees } = repoWithBranches([parent, candidate])
    const project = 'landing-scoped-outdated-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      g(trees[candidate]!, 'rebase', parent)
      const oldBase = g(repo, 'rev-parse', 'main')
      const parentReview = completedReview(project, [g(repo, 'rev-parse', `${parent}^{tree}`)], {
        branch: parent, baseCommit: oldBase, launchCwd: trees[parent]!,
      })
      const candidateReview = completedReview(project, [g(repo, 'rev-parse', `${candidate}^{tree}`)], {
        branch: candidate, baseCommit: oldBase, launchCwd: trees[candidate]!,
      })
      writeFileSync(join(trees[candidate]!, 'after-review.txt'), 'new candidate content\n')
      g(trees[candidate]!, 'add', 'after-review.txt')
      g(trees[candidate]!, 'commit', '-m', 'change candidate after review')

      const child = childLand(repo, candidate, { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      expect(db().query('SELECT outdated_at, outdated_reason FROM review WHERE id=?').get(candidateReview))
        .toEqual({ outdated_at: expect.any(String), outdated_reason: 'patch-id differs' })
      expect(db().query('SELECT outdated_at, outdated_reason FROM review WHERE id=?').get(parentReview))
        .toEqual({ outdated_at: null, outdated_reason: null })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a missing trunk cannot produce a carried review verdict', () => {
    const branch = 'missing-trunk-review'
    const { repo, trees } = repoWithBranches([branch])
    const project = 'landing-missing-trunk-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'missing-trunk', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedTree = g(repo, 'rev-parse', `${branch}^{tree}`)
      completedReview(project, [reviewedTree], {
        branch, baseCommit: oldBase, launchCwd: trees[branch]!,
      })
      writeFileSync(join(trees[branch]!, 'after-review.txt'), 'new content\n')
      g(trees[branch]!, 'add', 'after-review.txt')
      g(trees[branch]!, 'commit', '-m', 'content after review')

      const status = landingReviewCoverage(trees[branch]!)
      expect(status).toContain('1 review not evidence (example: review')
      expect(status).toContain('git merge-base')
      expect(status).toContain('missing-trunk')
      expect(status).not.toContain('carried')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('carries a whitespace-only post-review change when stable patch-id is unchanged', async () => {
    const { repo, trees } = repoWithBranches(['whitespace-review'])
    const project = 'landing-whitespace-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedTree = g(repo, 'rev-parse', 'whitespace-review^{tree}')
      completedReview(project, [reviewedTree], {
        branch: 'whitespace-review', baseCommit: oldBase, launchCwd: trees['whitespace-review']!,
      })
      writeFileSync(join(trees['whitespace-review']!, 'whitespace-review.txt'), 'whitespace-review \n')
      g(trees['whitespace-review']!, 'add', 'whitespace-review.txt')
      g(trees['whitespace-review']!, 'commit', '-m', 'whitespace after review')
      const child = childLand(repo, 'whitespace-review', { unreviewed: null })
      expect(await child.exited).toBe(0)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a binary payload replacement after review changes the stable patch-id', async () => {
    const branch = 'binary-review'
    const { repo, trees } = repoWithBranches([branch])
    const project = 'landing-binary-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const binaryPath = join(trees[branch]!, 'payload.bin')
      writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]))
      g(trees[branch]!, 'add', 'payload.bin')
      g(trees[branch]!, 'commit', '-m', 'add binary payload')
      const reviewedTree = g(repo, 'rev-parse', `${branch}^{tree}`)
      const reviewId = completedReview(project, [reviewedTree], {
        branch, baseCommit: oldBase, launchCwd: trees[branch]!,
      })
      const reviewedPatch = (db().query('SELECT patch_id FROM review WHERE id=?').get(reviewId) as
        { patch_id: string }).patch_id

      writeFileSync(binaryPath, Buffer.from([0, 9, 8, 7]))
      g(trees[branch]!, 'add', 'payload.bin')
      g(trees[branch]!, 'commit', '-m', 'replace binary payload')

      expect(landingReviewCoverage(trees[branch]!)).toContain('lenses missing: lens-1')
      const child = childLand(repo, branch, { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('patch-id differs')
      expect((db().query('SELECT patch_id FROM review WHERE id=?').get(reviewId) as
        { patch_id: string }).patch_id).toBe(reviewedPatch)
      expect(db().query('SELECT outdated_at, outdated_reason FROM review WHERE id=?').get(reviewId))
        .toEqual({ outdated_at: expect.any(String), outdated_reason: 'patch-id differs' })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a review when one lens has incomplete carry metadata', async () => {
    const { repo, trees } = repoWithBranches(['partial-metadata-review'])
    const project = 'landing-partial-metadata-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedTree = g(repo, 'rev-parse', 'partial-metadata-review^{tree}')
      const reviewId = completedReview(project, [reviewedTree, reviewedTree], {
        branch: 'partial-metadata-review', baseCommit: oldBase,
        launchCwd: trees['partial-metadata-review']!,
      })
      const second = db().query(
        'SELECT id FROM review_lens WHERE review_id=? ORDER BY id DESC LIMIT 1',
      ).get(reviewId) as { id: number }
      db().query('UPDATE run SET branch=NULL, base_commit=NULL WHERE id=(SELECT run_id FROM review_lens WHERE id=?)')
        .run(second.id)
      writeFileSync(join(repo, 'metadata-trunk.txt'), 'unrelated\n')
      g(repo, 'add', 'metadata-trunk.txt')
      g(repo, 'commit', '-m', 'move trunk for metadata')
      const child = childLand(repo, 'partial-metadata-review', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('lens metadata incomplete')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a review when its lens base commits disagree', async () => {
    const { repo, trees } = repoWithBranches(['disagreeing-bases-review'])
    const project = 'landing-disagreeing-bases-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedCommit = g(repo, 'rev-parse', 'disagreeing-bases-review')
      const reviewedTree = g(repo, 'rev-parse', 'disagreeing-bases-review^{tree}')
      const reviewId = completedReview(project, [reviewedTree, reviewedTree], {
        branch: 'disagreeing-bases-review', baseCommit: oldBase,
        launchCwd: trees['disagreeing-bases-review']!,
      })
      const second = db().query(
        'SELECT id FROM review_lens WHERE review_id=? ORDER BY id DESC LIMIT 1',
      ).get(reviewId) as { id: number }
      db().query('UPDATE run SET base_commit=? WHERE id=(SELECT run_id FROM review_lens WHERE id=?)')
        .run(reviewedCommit, second.id)
      writeFileSync(join(repo, 'bases-trunk.txt'), 'unrelated\n')
      g(repo, 'add', 'bases-trunk.txt')
      g(repo, 'commit', '-m', 'move trunk for bases')
      const child = childLand(repo, 'disagreeing-bases-review', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('lens bases disagree')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('refuses a carry when no commit with the reviewed tree remains reachable', async () => {
    const { repo, trees } = repoWithBranches(['missing-review'])
    const project = 'landing-missing-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedCommit = g(repo, 'rev-parse', 'missing-review')
      const reviewedTree = g(repo, 'rev-parse', 'missing-review^{tree}')
      const reviewId = completedReview(project, [reviewedTree], {
        branch: 'missing-review', baseCommit: oldBase, launchCwd: trees['missing-review']!,
      })
      const runId = (db().query('SELECT run_id FROM review_lens WHERE review_id=?').get(reviewId) as
        { run_id: number }).run_id
      g(repo, 'update-ref', '-d', `refs/orch/reviewed/${runId}`)
      db().query('UPDATE run SET head_commit=NULL WHERE id=?').run(runId)
      g(trees['missing-review']!, 'reset', '--hard', 'main')
      writeFileSync(join(trees['missing-review']!, 'replacement.txt'), 'replacement\n')
      g(trees['missing-review']!, 'add', 'replacement.txt')
      g(trees['missing-review']!, 'commit', '-m', 'replacement history')
      g(repo, 'reflog', 'expire', '--expire=now', '--all')
      g(repo, 'gc', '--prune=now')
      expect(() => g(repo, 'cat-file', '-e', `${reviewedCommit}^{commit}`)).toThrow()
      const child = childLand(repo, 'missing-review', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('1 review not evidence')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('one mismatched lens makes the whole completed review fail coverage', async () => {
    const { repo, trees } = repoWithBranches(['mixed-review'])
    const project = 'landing-mixed-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const tree = g(trees['mixed-review']!, 'rev-parse', 'HEAD^{tree}')
      // New recordings refuse this grouping. Insert the legacy/inconsistent
      // shape directly to prove landing still treats it as uncovered.
      const one = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'one', repo: project })
      const two = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'two', repo: project })
      const review = (db().query(
        "INSERT INTO review (recorded_at, completed_at) VALUES ('now','now') RETURNING id",
      ).get() as { id: number }).id
      const insert = db().query(
        `INSERT INTO review_lens
          (review_id,run_id,lens,agent,model,tree_inspected,reviewed_tree,standards_read,
           files_covered,commands_run,could_not_verify) VALUES (?,?,?,?,?,NULL,?,'[]','[]','[]','[]')`,
      )
      insert.run(review, one, 'one', 'codex', 'm', tree)
      insert.run(review, two, 'two', 'codex', 'm', '0000000000000000000000000000000000000000')
      const child = childLand(repo, 'mixed-review', { unreviewed: null })
      expect(await child.exited).not.toBe(0)
      const error = await new Response(child.stderr).text()
      expect(error).toContain('lenses present: none')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a trunk move during landing carries the review after the serialized re-gate', async () => {
    const { repo, trees } = repoWithBranches(['stale-review'])
    const project = 'landing-stale-review'
    const gate = join(repo, 'review-gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nc='${repo}/gate-count'; n=0; [ ! -e "$c" ] || n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"\nif [ "$n" = 1 ]; then touch '${repo}/first-review-gate'; while [ ! -e '${repo}/release-review-gate' ]; do sleep 0.01; done; fi\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate } })
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedTree = g(trees['stale-review']!, 'rev-parse', 'HEAD^{tree}')
      completedReview(project, [reviewedTree], {
        branch: 'stale-review', baseCommit: oldBase, launchCwd: trees['stale-review']!,
      })
      const child = childLand(repo, 'stale-review', { unreviewed: null })
      for (let i = 0; i < 200 && !existsSync(join(repo, 'first-review-gate')); i++) await Bun.sleep(5)
      writeFileSync(join(repo, 'trunk-move.txt'), 'move\n')
      g(repo, 'add', 'trunk-move.txt')
      g(repo, 'commit', '-m', 'move trunk')
      const moved = g(repo, 'rev-parse', 'main')
      writeFileSync(join(repo, 'release-review-gate'), '')
      expect(await child.exited).toBe(0)
      expect(g(repo, 'merge-base', '--is-ancestor', moved, 'main')).toBe('')
      expect(db().query(
        'SELECT old_base,new_base FROM landing_review_carry WHERE branch=?',
      ).get('stale-review')).toEqual({ old_base: oldBase, new_base: moved })
      expect(db().query(
        "SELECT resource_kind, event_kind, resource_key FROM contention WHERE event_kind='retry'",
      ).get()).toEqual({
        resource_kind: 'trunk', event_kind: 'retry', resource_key: 'landing-stale-review',
      })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  }, 15_000)

  test('a dropped contention table does not skip re-gate', async () => {
    const { repo, trees } = repoWithBranches(['stale-review'])
    const project = 'landing-stale-review-no-contention'
    const gate = join(repo, 'review-gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nc='${repo}/gate-count'; n=0; [ ! -e "$c" ] || n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"\nif [ "$n" = 1 ]; then touch '${repo}/first-review-gate'; while [ ! -e '${repo}/release-review-gate' ]; do sleep 0.01; done; fi\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate } })
    const table = db().query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='contention'",
    ).get() as { sql: string }
    const indexes = db().query(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='contention' AND sql IS NOT NULL",
    ).all() as { sql: string }[]
    db().exec('DROP TABLE contention')
    try {
      const oldBase = g(repo, 'rev-parse', 'main')
      const reviewedTree = g(trees['stale-review']!, 'rev-parse', 'HEAD^{tree}')
      completedReview(project, [reviewedTree], {
        branch: 'stale-review', baseCommit: oldBase, launchCwd: trees['stale-review']!,
      })
      const child = childLand(repo, 'stale-review', { unreviewed: null })
      for (let i = 0; i < 200 && !existsSync(join(repo, 'first-review-gate')); i++) await Bun.sleep(5)
      writeFileSync(join(repo, 'trunk-move.txt'), 'move\n')
      g(repo, 'add', 'trunk-move.txt')
      g(repo, 'commit', '-m', 'move trunk')
      const moved = g(repo, 'rev-parse', 'main')
      writeFileSync(join(repo, 'release-review-gate'), '')
      expect(await child.exited).toBe(0)
      expect(g(repo, 'merge-base', '--is-ancestor', moved, 'main')).toBe('')
      expect(db().query(
        'SELECT old_base,new_base FROM landing_review_carry WHERE branch=?',
      ).get('stale-review')).toEqual({ old_base: oldBase, new_base: moved })
      expect(db().query(
        "SELECT status FROM landing WHERE branch='stale-review'",
      ).get()).toEqual({ status: 'landed' })
    } finally {
      try {
        db().exec(table.sql)
        for (const index of indexes) db().exec(index.sql)
      } catch { /* restore is best-effort for later tests */ }
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)
})
