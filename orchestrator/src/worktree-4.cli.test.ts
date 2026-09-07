import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, readdirSync, symlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import * as ts from 'typescript'
import { AGENTS, candidates, changedRegisteredCheckouts, checkoutAliases, checkoutCaseSensitivity, db, dir, hermeticGitEnv, mainCheckoutOf, orphanSafety, removeFor, retargetRepositoryPrompt, retargetRepositoryPromptForDispatch, retargetedPrompt, run, scrubbedGitEnv, snapshotRegisteredCheckouts, targetGitEnvironment, upsertProject } from '../test/fixture.ts'

describe('production git environments', () => {
  test('the shared scrub removes worker git routing and preserves unrelated variables', () => {
    const contaminated: NodeJS.ProcessEnv = {
      UNRELATED: 'preserved',
      GIT_DIR: '/worker/git-dir',
      GIT_WORK_TREE: '/worker/tree',
      GIT_OBJECT_DIRECTORY: '/worker/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/worker/alternates',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/worker/hooks',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '*',
      GIT_CONFIG_GLOBAL: '/worker/global-config',
      GIT_CONFIG_SYSTEM: '/worker/system-config',
      GIT_CONFIG_NOSYSTEM: '1',
      ORCH_GUARDED_GIT_COMMON_DIR: '/worker/common',
      ORCH_ALLOWED_GIT_REF: 'refs/heads/worker',
    }
    const scrubbed = scrubbedGitEnv(contaminated)
    expect(scrubbed.UNRELATED).toBe('preserved')
    for (const variable of Object.keys(contaminated).filter((key) => key !== 'UNRELATED')) {
      expect(scrubbed[variable]).toBeUndefined()
    }
  })

  test('a guarded linked target receives its own object routing after inherited routing is scrubbed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-target-git-env-'))
    const linked = join(repo, 'linked')
    const previous = Object.fromEntries([
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
      'ORCH_GUARDED_GIT_COMMON_DIR', 'ORCH_ALLOWED_GIT_REF',
    ].map((key) => [key, process.env[key]]))
    const fixtureGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      fixtureGit('init', '-b', 'main')
      fixtureGit('config', 'user.email', 'orch-test@example.invalid')
      fixtureGit('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked'), 'fixture\n')
      fixtureGit('add', 'tracked')
      fixtureGit('commit', '-m', 'fixture')
      fixtureGit('worktree', 'add', '-b', 'guarded-target', linked)
      const pointer = readFileSync(join(linked, '.git'), 'utf8').trim().slice('gitdir: '.length)
      const linkedGitDir = realpathSync(resolve(linked, pointer))
      mkdirSync(join(linkedGitDir, 'objects'))
      Object.assign(process.env, {
        GIT_DIR: '/worker/git-dir', GIT_WORK_TREE: '/worker/tree',
        GIT_OBJECT_DIRECTORY: '/worker/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/worker/alternates',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/worker/hooks',
        ORCH_GUARDED_GIT_COMMON_DIR: '/worker/common', ORCH_ALLOWED_GIT_REF: 'refs/heads/worker',
      })
      const target = targetGitEnvironment(linked)
      expect(target.GIT_OBJECT_DIRECTORY).toBe(join(linkedGitDir, 'objects'))
      expect(target.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(realpathSync(join(repo, '.git', 'objects')))
      expect(target.GIT_DIR).toBeUndefined()
      expect(target.GIT_CONFIG_COUNT).toBeUndefined()
      expect(target.ORCH_GUARDED_GIT_COMMON_DIR).toBeUndefined()
      expect(target.ORCH_ALLOWED_GIT_REF).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('main checkout resolution does not merge inherited object routing into a supplied environment', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-main-checkout-env-'))
    const previous = process.env.GIT_OBJECT_DIRECTORY
    try {
      const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
      process.env.GIT_OBJECT_DIRECTORY = '/nonexistent/worker/objects'
      expect(mainCheckoutOf(repo, hermeticGitEnv())).toBe(realpathSync(repo))
    } finally {
      if (previous === undefined) delete process.env.GIT_OBJECT_DIRECTORY
      else process.env.GIT_OBJECT_DIRECTORY = previous
      rmSync(repo, { recursive: true, force: true })
    }
  })

  const productionGitEnvironmentViolations = (
    roots: string[], diagnosticRoot: string,
  ): string[] => {
    const violations: string[] = []
    const files: string[] = []
    const collect = (root: string) => {
      if (!existsSync(root)) return
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
      }
    }
    roots.forEach(collect)
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Bun' &&
            (node.expression.name.text === 'spawn' || node.expression.name.text === 'spawnSync') &&
            ts.isArrayLiteralExpression(node.arguments[0]!) &&
            ts.isStringLiteral(node.arguments[0]!.elements[0]!) &&
            node.arguments[0]!.elements[0]!.text === 'git') {
          const options = node.arguments[1]
          const env = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((property) =>
                (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
                property.name.getText(file) === 'env')
            : undefined
          const raw = env && ts.isPropertyAssignment(env) && env.initializer.getText(file).includes('process.env')
          if (!env || raw) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
            violations.push(`${relative(diagnosticRoot, path)}:${line}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    return violations
  }

  const productionTransactionViolations = (
    roots: string[], diagnosticRoot: string,
  ): string[] => {
    const violations: string[] = []
    const files: string[] = []
    const collect = (root: string) => {
      if (!existsSync(root)) return
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
      }
    }
    roots.forEach(collect)
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'transaction') {
          let parent: ts.Node | undefined = node
          let sanctioned = false
          while (parent) {
            if (ts.isFunctionDeclaration(parent) && parent.name?.text === 'writeTransaction' &&
                basename(path) === 'db.ts') {
              sanctioned = true
              break
            }
            parent = parent.parent
          }
          if (!sanctioned) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
            violations.push(`${relative(diagnosticRoot, path)}:${line}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    return violations
  }

  test('every production git spawn supplies an environment without raw process.env', () => {
    const sourceDir = dirname(new URL(import.meta.url).pathname)
    const repoRoot = resolve(sourceDir, '../..')
    const violations = productionGitEnvironmentViolations(
      [sourceDir, join(repoRoot, 'shared')], repoRoot,
    )
    expect(violations).toEqual([])
  })

  test('the production git lint recurses shared and names an unsafe nested site', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-git-lint-'))
    const nested = join(fixture, 'shared', 'nested')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'unsafe.ts'), "Bun.spawnSync(['git', 'status'])\n")
    try {
      expect(productionGitEnvironmentViolations([join(fixture, 'shared')], fixture))
        .toEqual(['shared/nested/unsafe.ts:1'])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('only db.ts:writeTransaction opens a production transaction, and the lint names the site', () => {
    const sourceDir = dirname(new URL(import.meta.url).pathname)
    const repoRoot = resolve(sourceDir, '../..')
    expect(productionTransactionViolations([sourceDir], repoRoot)).toEqual([])

    const fixture = mkdtempSync(join(tmpdir(), 'orch-transaction-lint-'))
    const nested = join(fixture, 'src', 'nested')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'unsafe.ts'), 'database.transaction(() => {})()\n')
    try {
      expect(productionTransactionViolations([join(fixture, 'src')], fixture))
        .toEqual(['src/nested/unsafe.ts:1'])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('outside-worktree write observation', () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  const repository = () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-outside-write-')))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'fixture')
    return repo
  }

  test('the comparison names a changed checkout and ignores an unchanged one', () => {
    const before = [
      { project: 'one', path: '/one', status: '' },
      { project: 'two', path: '/two', status: ' M existing' },
    ]
    expect(changedRegisteredCheckouts(before, [
      { project: 'one', path: '/one', status: '?? new.txt\0' },
      { project: 'two', path: '/two', status: ' M existing' },
    ])).toEqual([{
      project: 'one', path: '/one', before: '', after: '?? new.txt\0',
    }])
  })

  test('the comparison reports a registered checkout whose HEAD is not trunk even when porcelain is unchanged', () => {
    expect(changedRegisteredCheckouts(
      [{ project: 'one', path: '/one', status: '', head: 'topic', expectedHead: 'main' }],
      [{ project: 'one', path: '/one', status: '', head: 'topic', expectedHead: 'main' }],
    )).toEqual([{
      project: 'one', path: '/one', before: '', after: '',
      beforeHead: 'topic', afterHead: 'topic', expectedHead: 'main',
    }])
  })

  test('an explicitly watched caller worktree is observed even when the register names its main checkout', () => {
    const main = repository()
    const caller = realpathSync(mkdtempSync(join(tmpdir(), 'orch-outside-caller-')))
    git(main, 'worktree', 'add', '--detach', caller)
    try {
      expect(snapshotRegisteredCheckouts([{ project: 'watched-project', path: caller }]))
        .toContainEqual({
          project: 'watched-project', path: caller, status: '', head: null, expectedHead: null,
        })
      writeFileSync(join(caller, 'written-by-run.txt'), 'outside\n')
      expect(snapshotRegisteredCheckouts([{ project: 'watched-project', path: caller }]))
        .toContainEqual({
          project: 'watched-project', path: caller, status: '?? written-by-run.txt\u0000',
          head: null, expectedHead: null,
        })
    } finally {
      git(main, 'worktree', 'remove', '--force', caller)
      rmSync(main, { recursive: true, force: true })
    }
  })

  test('caller paths in a review pack are retargeted at filesystem boundaries', () => {
    const caller = '/repo with [meta]*'
    const worktree = `${caller}/.claude/worktrees/orch-1`
    expect(retargetedPrompt(`${caller}/subdir/subject.txt`, `${caller}/`, worktree))
      .toBe(`${worktree}/subdir/subject.txt`)
    expect(retargetedPrompt(caller, caller, worktree)).toBe(worktree)
    expect(retargetedPrompt(`${caller}-archive/subject.txt`, caller, worktree))
      .toBe(`${caller}-archive/subject.txt`)
    expect(retargetedPrompt(`word${caller}/subject.txt`, caller, worktree))
      .toBe(`word${caller}/subject.txt`)
    for (const prefix of ['', ' ', '\n', '"', "'", '`', '=', ':', ',', '(', '[', '{', '<']) {
      expect(retargetedPrompt(`${prefix}${caller}/subject.txt`, caller, worktree))
        .toBe(`${prefix}${worktree}/subject.txt`)
    }
    const bound = `read ${worktree}/subject.txt`
    expect(retargetedPrompt(bound, caller, worktree)).toBe(bound)
    expect(retargetedPrompt('unchanged', '', worktree)).toBe('unchanged')
    expect(retargetedPrompt('/subject.txt', '/', '/worktree')).toBe('/subject.txt')
    expect(retargetedPrompt('/', '/', '/worktree')).toBe('/')
    expect(retargetedPrompt(
      '/repo\nline [meta]*/subject.txt', '/repo\nline [meta]*', '/worktree',
    )).toBe('/worktree/subject.txt')
  })

  test('path ends, alias specificity, URI authorities, and malformed aliases are one rule', () => {
    expect(retargetedPrompt(
      '/repo, /repo) /repo: /repo. /repo-archive /repo.git /repo-\n/repo\nnext',
      '/repo', '/wt',
    )).toBe('/wt, /wt) /wt: /wt. /repo-archive /repo.git /wt-\n/wt\nnext')

    const shorterTarget = retargetedPrompt(
      '/repo/main/file', '/repo/main', '/repo', false, ['/repo'],
    )
    expect(shorterTarget).toBe('/repo/file')
    expect(retargetedPrompt(
      retargetedPrompt(shorterTarget, '/repo/main', '/repo', false, ['/repo']),
      '/repo/main', '/repo', false, ['/repo'],
    )).toBe(shorterTarget)
    expect(retargetedPrompt('/repo/file', '/repo', '/', false, ['/']))
      .toBe('/file')
    expect(retargetedPrompt(
      'https://repo/file file:///repo/file', '/repo', '/wt',
    )).toBe('https://repo/file file:///wt/file')
    expect(retargetedPrompt(
      'https://example.test/repo/f file:///repo/f "https://host/repo/f" (ssh://host/repo/f)',
      '/repo', '/wt',
    )).toBe('https://example.test/wt/f file:///wt/f "https://host/wt/f" (ssh://host/wt/f)')
    expect(retargetedPrompt(
      'https://x.test/?path=/repo/file vscode://x/open?path=/repo/file file://host/?path=/repo/file',
      '/repo', '/wt',
    )).toBe(
      'https://x.test/?path=/wt/file vscode://x/open?path=/wt/file file://host/?path=/wt/file',
    )

    const first = retargetedPrompt('/repo/file', '/repo', '/repo/wt', false, [])
    expect(first).toBe('/repo/wt/file')
    const second = retargetedPrompt(first, '/repo', '/repo/wt', false, [])
    expect(retargetedPrompt(second, '/repo', '/repo/wt', false, [])).toBe(first)
    const aliased = retargetedPrompt(
      '/repo/file', '/repo', '/repo/wt', false, ['/repo/wt-alias'],
    )
    expect(aliased).toBe('/repo/wt/file')
    expect(retargetedPrompt(
      aliased, '/repo', '/repo/wt', false, ['/repo/wt-alias'],
    )).toBe(aliased)
    expect(retargetedPrompt('//repo/file', '/repo', '/wt')).toBe('//repo/file')

    expect(retargetRepositoryPrompt('/repo/file', '/repo', '', false, [])).toEqual({
      prompt: '/repo/file',
      diagnostic: 'review path retargeting indeterminate: destination is empty',
    })
    expect(retargetRepositoryPrompt('//repo ///repo', '/', '/wt', false, [])).toEqual({
      prompt: '//repo ///repo',
      diagnostic: 'review path retargeting indeterminate: caller alias is filesystem root (/)',
    })
    expect(retargetRepositoryPrompt('//repo/file', '//repo', '/wt', false, [])).toEqual({
      prompt: '//repo/file',
      diagnostic: 'review path retargeting indeterminate: unsupported alias //repo',
    })
    expect(retargetRepositoryPrompt('/repo/file', '/repo/', '/repo', false, [])).toEqual({
      prompt: '/repo/file',
      diagnostic: 'review path retargeting indeterminate: alias has both source and target roles (/repo)',
    })
    const refused: Array<[string, string, string, boolean, string[]]> = [
      ['/repo/file', '/repo', '', false, []],
      ['//repo ///repo', '/', '/wt', false, []],
      ['//repo/file', '//repo', '/wt', false, []],
      ['/repo/file', '/repo/', '/repo', false, []],
    ]
    for (const args of refused) {
      expect(() => retargetRepositoryPromptForDispatch(...args)).toThrow(
        'review path retargeting indeterminate:',
      )
    }
  })

  test('suffix boundaries are lexical and independent of filesystem state', () => {
    const parent = mkdtempSync(join(tmpdir(), 'orch-retarget-boundary-'))
    const caller = join(parent, 'repo')
    const worktree = join(parent, 'wt')
    mkdirSync(caller)
    mkdirSync(worktree)
    try {
      const prompt = `Inspect ${caller}. ${caller}, ${caller}/sub ` +
        `${caller}@archive ${caller}-archive/f ${caller}.git ${caller}.x ` +
        `${caller}_archive ${caller},archive ${caller}:archive ${caller}+archive ` +
        `${caller}:+ word${caller}/f`
      const expected = `Inspect ${worktree}. ${worktree}, ${worktree}/sub ` +
        `${caller}@archive ${caller}-archive/f ${caller}.git ${caller}.x ` +
        `${caller}_archive ${caller},archive ${caller}:archive ${caller}+archive ` +
        `${caller}:+ word${caller}/f`
      expect(retargetedPrompt(prompt, caller, worktree)).toBe(expected)
      mkdirSync(`${caller}.`)
      mkdirSync(`${caller}-archive`)
      expect(retargetedPrompt(prompt, caller, worktree)).toBe(expected)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('shell operators end paths and Unicode name characters do not', () => {
    expect(retargetedPrompt(
      'cd /repo;pwd /repo|x /repo&&x /repo>out /repo<in /repo)next /repo`pwd` /repo$VAR',
      '/repo', '/wt',
    )).toBe('cd /wt;pwd /wt|x /wt&&x /wt>out /wt<in /wt)next /wt`pwd` /wt$VAR')
    expect(retargetedPrompt(
      '/repoé/f /repo١/f /repo\u0301/f /repo𐐀/f é/repo/f ١/repo/f e\u0301/repo/f 𐐀/repo/f /repo/é',
      '/repo', '/wt',
    )).toBe('/repoé/f /repo١/f /repo\u0301/f /repo𐐀/f é/repo/f ١/repo/f e\u0301/repo/f 𐐀/repo/f /wt/é')
    expect(retargetedPrompt(
      '/tmp/@/repo/file /tmp//repo/file', '/repo', '/wt',
    )).toBe('/tmp/@/wt/file /tmp//repo/file')
    const escapedPrompt = '—/repo/f @/repo/f ' + '\\' + '/repo/f'
    const escapedExpected = '—/wt/f @/wt/f ' + '\\' + '/wt/f'
    expect(retargetedPrompt(escapedPrompt, '/repo', '/wt')).toBe(escapedExpected)
  })

  test('case-insensitive aliases use the documented partial length-changing fold', () => {
    expect(retargetedPrompt(
      '/tmp/case/i̇/file /tmp/case/SS/file /tmp/case/fi/file',
      ['/tmp/case/İ', '/tmp/case/ß', '/tmp/case/ﬁ'], '/worktree', true,
    )).toBe('/worktree/file /worktree/file /worktree/file')
    expect(retargetedPrompt(
      '/tmp/case/İ/file /tmp/case/ß/file /tmp/case/ﬁ/file',
      ['/tmp/case/i̇', '/tmp/case/SS', '/tmp/case/fi'], '/worktree', true,
    )).toBe('/worktree/file /worktree/file /worktree/file')
  })

  test('the project worktree root protects every disposable tree from rebinding', () => {
    const caller = '/repo'
    const root = `${caller}/.claude/worktrees`
    const firstWorktree = `${root}/a`
    const secondWorktree = `${root}/b`
    const first = retargetedPrompt(`${caller}/file`, caller, firstWorktree, false, [root])
    expect(first).toBe(`${firstWorktree}/file`)
    expect(retargetedPrompt(first, caller, secondWorktree, false, [root])).toBe(first)
  })

  test('all checkout aliases follow the checkout filesystem case behavior', () => {
    const repo = repository()
    const alias = join(dirname(repo), `${basename(repo)}-alias`)
    symlinkSync(repo, alias)
    try {
      const checkout = checkoutAliases(`${alias}/`)
      expect(checkout).not.toBeNull()
      expect(checkout!.roots).toContain(`${alias}/`)
      expect(checkout!.roots).toContain(realpathSync(repo))
      const prompt = checkout!.roots
        .map((root) => `${root.replace(/\/+$/, '')}/subject.txt`).join('\n')
      expect(retargetedPrompt(
        prompt, checkout!.roots, '/worktree', checkout!.caseInsensitive,
      )).toBe(checkout!.roots.map(() => '/worktree/subject.txt').join('\n'))

      const uppercase = realpathSync(repo).toUpperCase()
      const expected = checkout!.caseInsensitive ? '/worktree/subject.txt' : `${uppercase}/subject.txt`
      expect(retargetedPrompt(
        `${uppercase}/subject.txt`, checkout!.roots, '/worktree', checkout!.caseInsensitive,
      )).toBe(expected)
    } finally {
      rmSync(alias)
      rmSync(repo, { recursive: true, force: true })
    }
    expect(checkoutCaseSensitivity('/')).toEqual({
      caseInsensitive: false,
      diagnostic: 'checkout case-sensitivity probe indeterminate: root has no alphabetic character (/); ' +
        'path matching uses a partial Unicode case fold; filesystem-specific folding beyond it is a known limit',
    })
  })

  test('a real run records an external write and a clean run records none', async () => {
    const watched = repository()
    const script = join(dir, 'outside-write-agent.sh')
    writeFileSync(script, `#!/bin/sh
if [ -n "$ORCH_TEST_EXTERNAL_WRITE" ]; then printf 'outside\\n' > "$ORCH_TEST_EXTERNAL_WRITE"; fi
if [ -n "$ORCH_TEST_INSIDE_WRITE" ]; then printf 'inside\\n' > "$ORCH_TEST_INSIDE_WRITE"; fi
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'watched-project', path: watched })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    const priorInside = process.env.ORCH_TEST_INSIDE_WRITE
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      process.env.ORCH_TEST_EXTERNAL_WRITE = join(watched, 'written-by-run.txt')
      let dirtyRunId: number | null = null
      try {
        await run({ job: 'file-question', prompt: 'write outside', cwd: dir, agent: 'grok' })
      } catch (error) {
        dirtyRunId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(dirtyRunId).not.toBeNull()
      const recorded = db().query(
        `SELECT status, failure_kind, error, outside_worktree_writes, output_path,
                worktree, branch, base_commit, worktree_source
           FROM run WHERE id=?`,
      ).get(dirtyRunId!) as {
        status: string; failure_kind: string; error: string
        outside_worktree_writes: string; output_path: string
        worktree: string | null; branch: string | null; base_commit: string | null
        worktree_source: 'recipe' | 'git' | 'readonly_recipe' | null
      }
      expect(recorded.status).toBe('failed')
      expect(recorded.failure_kind).toBe('escaped')
      expect(recorded.error).toContain(watched)
      expect(recorded.error).toContain('?? written-by-run.txt')
      expect(recorded.error).toContain('the writer is not established')
      expect(Buffer.byteLength(recorded.error)).toBeLessThanOrEqual(1500)
      expect(readFileSync(recorded.output_path, 'utf8')).toContain('answer')
      expect(JSON.parse(recorded.outside_worktree_writes)).toEqual([{
        project: 'watched-project', path: watched,
        before: '', after: '?? written-by-run.txt\u0000',
        beforeHead: 'main', afterHead: 'main', expectedHead: null,
      }])
      expect(db().query('SELECT id FROM run WHERE retry_of=?').get(dirtyRunId!)).toBeNull()
      expect(candidates('file-question').find((item) => item.agent === 'grok'))
        .toMatchObject({ failures: 0, evidence: 0, score: null })
      if (recorded.worktree && recorded.branch && recorded.base_commit) {
        expect(removeFor({
          path: recorded.worktree, branch: recorded.branch, base: recorded.base_commit,
          repoRoot: dir, source: recorded.worktree_source ?? undefined,
        }, dir).removed).toBe(true)
      }

      rmSync(join(watched, 'written-by-run.txt'))
      delete process.env.ORCH_TEST_EXTERNAL_WRITE
      process.env.ORCH_TEST_INSIDE_WRITE = 'inside-only.txt'
      const clean = await run({ job: 'file-question', prompt: 'write inside', cwd: dir, agent: 'grok' })
      const cleanRecorded = db().query(
        'SELECT status, failure_kind, outside_worktree_writes FROM run WHERE id=?',
      ).get(clean.id) as { status: string; failure_kind: string | null; outside_worktree_writes: string }
      expect(cleanRecorded).toMatchObject({ status: 'ok', failure_kind: null })
      expect(JSON.parse(cleanRecorded.outside_worktree_writes)).toEqual([])
      expect(clean.worktree && existsSync(join(clean.worktree.path, 'inside-only.txt'))).toBe(true)
      expect(snapshotRegisteredCheckouts()).toEqual([
        { project: 'watched-project', path: watched, status: '', head: 'main', expectedHead: null },
      ])

      process.env.ORCH_TEST_INSIDE_WRITE = 'inside-resume.txt'
      let resumedRunId: number | null = null
      try {
        const resumed = await run({
          job: 'file-question', prompt: 'resume and escape', cwd: clean.worktree!.path,
          resume: {
            parent: clean.id, agent: 'grok', session: 'test-session', turn: 2,
            sessionId: 'orch-test-session', worktree: clean.worktree,
          },
        })
        resumedRunId = resumed.id
      } catch (error) {
        resumedRunId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(resumedRunId).not.toBeNull()
      expect(db().query(
        'SELECT status, failure_kind, parent_run_id FROM run WHERE id=?',
      ).get(resumedRunId!)).toEqual({
        status: 'ok', failure_kind: null, parent_run_id: clean.id,
      })
      expect(existsSync(join(clean.worktree!.path, 'inside-resume.txt'))).toBe(true)
      if (clean.worktree) expect(removeFor(clean.worktree, clean.worktree.repoRoot).removed).toBe(true)
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      if (priorInside === undefined) delete process.env.ORCH_TEST_INSIDE_WRITE
      else process.env.ORCH_TEST_INSIDE_WRITE = priorInside
      rmSync(watched, { recursive: true, force: true })
    }
  })

  test('a moved registered checkout is warned and excluded from the frozen watch set', async () => {
    const movedParent = mkdtempSync(join(tmpdir(), 'orch-moved-project-'))
    const moved = join(movedParent, 'missing-at-launch')
    const script = join(dir, 'create-moved-project-agent.sh')
    writeFileSync(script, `#!/bin/sh
mkdir -p "$ORCH_TEST_MOVED_PROJECT"
printf 'created after launch\n' > "$ORCH_TEST_MOVED_PROJECT/file.txt"
printf '%s\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'moved-project', path: moved })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorMoved = process.env.ORCH_TEST_MOVED_PROJECT
    const originalError = console.error
    const warnings: string[] = []
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_MOVED_PROJECT = moved
    try {
      grok.bin = script
      console.error = (...args: unknown[]) => warnings.push(args.join(' '))
      const result = await run({
        job: 'file-question', prompt: 'proceed despite moved checkout', cwd: dir, agent: 'grok',
      })
      const row = db().query(
        'SELECT status, failure_kind, outside_worktree_writes FROM run WHERE id=?',
      ).get(result.id) as {
        status: string; failure_kind: string | null; outside_worktree_writes: string
      }
      expect(row).toMatchObject({ status: 'ok', failure_kind: null })
      expect(JSON.parse(row.outside_worktree_writes)).toEqual([])
      expect(warnings.filter((line) => line.includes('confinement watch skipped'))).toEqual([
        expect.stringContaining(
          `confinement watch skipped moved-project at ${moved}:`,
        ),
      ])
      expect(warnings[0]).toContain('fix the register with orch project set')
      if (result.worktree) expect(removeFor(result.worktree, result.worktree.repoRoot).removed).toBe(true)

      rmSync(moved, { recursive: true, force: true })
      warnings.length = 0
      const noTree = await run({
        job: 'summarize', prompt: 'no checkout required', cwd: dir, agent: 'grok',
      })
      expect(noTree.worktree).toBeNull()
      expect(warnings.some((line) => line.includes('confinement watch skipped'))).toBe(false)
    } finally {
      console.error = originalError
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorMoved === undefined) delete process.env.ORCH_TEST_MOVED_PROJECT
      else process.env.ORCH_TEST_MOVED_PROJECT = priorMoved
      rmSync(movedParent, { recursive: true, force: true })
    }
  })

  test('a checkout that cannot be sampled after launch fails confinement verification', async () => {
    const watched = repository()
    const hiddenGit = join(watched, '.git-hidden')
    const script = join(dir, 'hide-watched-git-agent.sh')
    writeFileSync(script, `#!/bin/sh
mv "$ORCH_TEST_HIDE_GIT/.git" "$ORCH_TEST_HIDE_GIT/.git-hidden"
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'unverifiable-project', path: watched })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_HIDE_GIT
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_HIDE_GIT = watched
    let runId: number | null = null
    try {
      grok.bin = script
      try {
        await run({ job: 'file-question', prompt: 'hide git', cwd: dir, agent: 'grok' })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      renameSync(hiddenGit, join(watched, '.git'))
      const row = db().query(
        `SELECT status, failure_kind, error, worktree, branch, base_commit, worktree_source
           FROM run WHERE id=?`,
      ).get(runId!) as {
        status: string; failure_kind: string; error: string
        worktree: string | null; branch: string | null; base_commit: string | null
        worktree_source: 'recipe' | 'git' | 'readonly_recipe' | null
      }
      expect(row.status).toBe('failed')
      expect(row.failure_kind).toBe('confinement_unverified')
      expect(row.error).toContain(watched)
      expect(row.error).toContain('after snapshot:')
      expect(row.error).toContain('not a git repository')
      expect(Buffer.byteLength(row.error)).toBeLessThanOrEqual(1500)
      expect(candidates('file-question').find((item) => item.agent === 'grok'))
        .toMatchObject({ failures: 0, evidence: 0, score: null })
      if (row.worktree && row.branch && row.base_commit) {
        expect(removeFor({
          path: row.worktree, branch: row.branch, base: row.base_commit,
          repoRoot: dir, source: row.worktree_source ?? undefined,
        }, dir).removed).toBe(true)
      }
    } finally {
      grok.bin = previousBin
      if (existsSync(hiddenGit) && !existsSync(join(watched, '.git'))) {
        renameSync(hiddenGit, join(watched, '.git'))
      }
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_HIDE_GIT
      else process.env.ORCH_TEST_HIDE_GIT = priorTarget
      rmSync(watched, { recursive: true, force: true })
    }
  })
})

describe('orphan worktrees keep anything unique', () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  test('only a clean worktree fully reachable from main is removable', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-orphan-'))
    const tree = join(repo, '.claude', 'worktrees', 'orphan')
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, 'add', 'kept.txt')
      git(repo, 'commit', '-m', 'base')
      git(repo, 'worktree', 'add', '-b', 'orphan', tree, 'main')

      expect(orphanSafety(tree, repo, 'main')).toMatchObject({ removable: true })
      writeFileSync(join(tree, 'new.txt'), 'unique\n')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: false, detail: 'has uncommitted changes',
      })
      git(tree, 'add', 'new.txt')
      git(tree, 'commit', '-m', 'unique')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: false, detail: 'has commits not reachable from main',
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
