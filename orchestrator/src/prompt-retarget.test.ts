import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { hermeticGitEnv } from '../test/fixtures/git.ts'
import { checkoutAliases, checkoutCaseSensitivity } from './checkout-identity.ts'
import { retargetRepositoryPrompt, retargetRepositoryPromptForDispatch, snapshotRegisteredCheckouts } from './prompt-retarget.ts'
describe('prompt retarget decisions', () => {
const git = (cwd: string, ...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()); return p.stdout.toString().trim() }
const repository = () => { const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-outside-write-'))); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid'); git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'tracked.txt'), 'base\n'); git(repo, 'add', 'tracked.txt'); git(repo, 'commit', '-m', 'fixture'); return repo }
test('caller paths in a review pack are retargeted at filesystem boundaries', () => {
    const caller = '/repo with [meta]*'
    const worktree = `${caller}/.claude/worktrees/orch-1`
    expect(retargetRepositoryPrompt(`${caller}/subdir/subject.txt`, `${caller}/`, worktree, false, []).prompt)
      .toBe(`${worktree}/subdir/subject.txt`)
    expect(retargetRepositoryPrompt(caller, caller, worktree, false, []).prompt).toBe(worktree)
    expect(retargetRepositoryPrompt(`${caller}-archive/subject.txt`, caller, worktree, false, []).prompt)
      .toBe(`${caller}-archive/subject.txt`)
    expect(retargetRepositoryPrompt(`word${caller}/subject.txt`, caller, worktree, false, []).prompt)
      .toBe(`word${caller}/subject.txt`)
    for (const prefix of ['', ' ', '\n', '"', "'", '`', '=', ':', ',', '(', '[', '{', '<']) {
      expect(retargetRepositoryPrompt(`${prefix}${caller}/subject.txt`, caller, worktree, false, []).prompt)
        .toBe(`${prefix}${worktree}/subject.txt`)
    }
    const bound = `read ${worktree}/subject.txt`
    expect(retargetRepositoryPrompt(bound, caller, worktree, false, []).prompt).toBe(bound)
    expect(retargetRepositoryPrompt('unchanged', '', worktree, false, []).prompt).toBe('unchanged')
    expect(retargetRepositoryPrompt('/subject.txt', '/', '/worktree', false, []).prompt).toBe('/subject.txt')
    expect(retargetRepositoryPrompt('/', '/', '/worktree', false, []).prompt).toBe('/')
    expect(retargetRepositoryPrompt(
      '/repo\nline [meta]*/subject.txt', '/repo\nline [meta]*', '/worktree', false, []
    ).prompt).toBe('/worktree/subject.txt')
  })

test('path ends, alias specificity, URI authorities, and malformed aliases are one rule', () => {
    expect(retargetRepositoryPrompt(
      '/repo, /repo) /repo: /repo. /repo-archive /repo.git /repo-\n/repo\nnext',
      '/repo', '/wt', false, []
    ).prompt).toBe('/wt, /wt) /wt: /wt. /repo-archive /repo.git /wt-\n/wt\nnext')

    const shorterTarget = retargetRepositoryPrompt(
      '/repo/main/file', '/repo/main', '/repo', false, ['/repo'],
    ).prompt
    expect(shorterTarget).toBe('/repo/file')
    expect(retargetRepositoryPrompt(
      retargetRepositoryPrompt(shorterTarget, '/repo/main', '/repo', false, ['/repo']).prompt,
      '/repo/main', '/repo', false, ['/repo'],
    ).prompt).toBe(shorterTarget)
    expect(retargetRepositoryPrompt('/repo/file', '/repo', '/', false, ['/']).prompt)
      .toBe('/file')
    expect(retargetRepositoryPrompt(
      'https://repo/file file:///repo/file', '/repo', '/wt', false, []
    ).prompt).toBe('https://repo/file file:///wt/file')
    expect(retargetRepositoryPrompt(
      'https://example.test/repo/f file:///repo/f "https://host/repo/f" (ssh://host/repo/f)',
      '/repo', '/wt', false, []
    ).prompt).toBe('https://example.test/wt/f file:///wt/f "https://host/wt/f" (ssh://host/wt/f)')
    expect(retargetRepositoryPrompt(
      'https://x.test/?path=/repo/file vscode://x/open?path=/repo/file file://host/?path=/repo/file',
      '/repo', '/wt', false, []
    ).prompt).toBe(
      'https://x.test/?path=/wt/file vscode://x/open?path=/wt/file file://host/?path=/wt/file',
    )

    const first = retargetRepositoryPrompt('/repo/file', '/repo', '/repo/wt', false, []).prompt
    expect(first).toBe('/repo/wt/file')
    const second = retargetRepositoryPrompt(first, '/repo', '/repo/wt', false, []).prompt
    expect(retargetRepositoryPrompt(second, '/repo', '/repo/wt', false, []).prompt).toBe(first)
    const aliased = retargetRepositoryPrompt(
      '/repo/file', '/repo', '/repo/wt', false, ['/repo/wt-alias'],
    ).prompt
    expect(aliased).toBe('/repo/wt/file')
    expect(retargetRepositoryPrompt(
      aliased, '/repo', '/repo/wt', false, ['/repo/wt-alias'],
    ).prompt).toBe(aliased)
    expect(retargetRepositoryPrompt('//repo/file', '/repo', '/wt', false, []).prompt).toBe('//repo/file')

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
      expect(retargetRepositoryPrompt(prompt, caller, worktree, false, []).prompt).toBe(expected)
      mkdirSync(`${caller}.`)
      mkdirSync(`${caller}-archive`)
      expect(retargetRepositoryPrompt(prompt, caller, worktree, false, []).prompt).toBe(expected)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

test('shell operators end paths and Unicode name characters do not', () => {
    expect(retargetRepositoryPrompt(
      'cd /repo;pwd /repo|x /repo&&x /repo>out /repo<in /repo)next /repo`pwd` /repo$VAR',
      '/repo', '/wt', false, []
    ).prompt).toBe('cd /wt;pwd /wt|x /wt&&x /wt>out /wt<in /wt)next /wt`pwd` /wt$VAR')
    expect(retargetRepositoryPrompt(
      '/repoé/f /repo١/f /repo\u0301/f /repo𐐀/f é/repo/f ١/repo/f e\u0301/repo/f 𐐀/repo/f /repo/é',
      '/repo', '/wt', false, []
    ).prompt).toBe('/repoé/f /repo١/f /repo\u0301/f /repo𐐀/f é/repo/f ١/repo/f e\u0301/repo/f 𐐀/repo/f /wt/é')
    expect(retargetRepositoryPrompt(
      '/tmp/@/repo/file /tmp//repo/file', '/repo', '/wt', false, []
    ).prompt).toBe('/tmp/@/wt/file /tmp//repo/file')
    const escapedPrompt = '—/repo/f @/repo/f ' + '\\' + '/repo/f'
    const escapedExpected = '—/wt/f @/wt/f ' + '\\' + '/wt/f'
    expect(retargetRepositoryPrompt(escapedPrompt, '/repo', '/wt', false, []).prompt).toBe(escapedExpected)
  })

test('case-insensitive aliases use the documented partial length-changing fold', () => {
    expect(retargetRepositoryPrompt(
      '/tmp/case/i̇/file /tmp/case/SS/file /tmp/case/fi/file',
      ['/tmp/case/İ', '/tmp/case/ß', '/tmp/case/ﬁ'], '/worktree', true, []
    ).prompt).toBe('/worktree/file /worktree/file /worktree/file')
    expect(retargetRepositoryPrompt(
      '/tmp/case/İ/file /tmp/case/ß/file /tmp/case/ﬁ/file',
      ['/tmp/case/i̇', '/tmp/case/SS', '/tmp/case/fi'], '/worktree', true, []
    ).prompt).toBe('/worktree/file /worktree/file /worktree/file')
  })

test('the project worktree root protects every disposable tree from rebinding', () => {
    const caller = '/repo'
    const root = `${caller}/.claude/worktrees`
    const firstWorktree = `${root}/a`
    const secondWorktree = `${root}/b`
    const first = retargetRepositoryPrompt(`${caller}/file`, caller, firstWorktree, false, [root]).prompt
    expect(first).toBe(`${firstWorktree}/file`)
    expect(retargetRepositoryPrompt(first, caller, secondWorktree, false, [root]).prompt).toBe(first)
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
      expect(retargetRepositoryPrompt(
        prompt, checkout!.roots, '/worktree', checkout!.caseInsensitive, []
      ).prompt).toBe(checkout!.roots.map(() => '/worktree/subject.txt').join('\n'))

      const uppercase = realpathSync(repo).toUpperCase()
      const expected = checkout!.caseInsensitive ? '/worktree/subject.txt' : `${uppercase}/subject.txt`
      expect(retargetRepositoryPrompt(
        `${uppercase}/subject.txt`, checkout!.roots, '/worktree', checkout!.caseInsensitive, []
      ).prompt).toBe(expected)
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

})

describe('registered caller snapshots',()=>{
const git=(cwd:string,...args:string[])=>{const p=Bun.spawnSync(['git',...args],{cwd,env:hermeticGitEnv(),stdout:'pipe',stderr:'pipe'});if(p.exitCode!==0)throw new Error(p.stderr.toString());return p.stdout.toString().trim()}
const repository=()=>{const repo=realpathSync(mkdtempSync(join(tmpdir(),'orch-outside-write-')));git(repo,'init','-b','main');git(repo,'config','user.email','orch-test@example.invalid');git(repo,'config','user.name','Orch Test');writeFileSync(join(repo,'tracked.txt'),'base\n');git(repo,'add','tracked.txt');git(repo,'commit','-m','fixture');return repo}
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
})
