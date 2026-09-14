import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixtures/git.ts'
import { upsertProject } from './projects.ts'

describe('checkout watch selection',()=>{
const repositories:string[]=[]
afterEach(()=>{for(const repo of repositories.splice(0))rmSync(repo,{recursive:true,force:true})})
const git=(cwd:string,...args:string[])=>{const p=Bun.spawnSync(['git',...args],{cwd,env:hermeticGitEnv(),stdout:'pipe',stderr:'pipe'});if(p.exitCode!==0)throw new Error(p.stderr.toString());return p.stdout.toString().trim()}
const repository=()=>{const repo=realpathSync(mkdtempSync(join(tmpdir(),'orch-outside-write-')));repositories.push(repo);git(repo,'init','-b','main');git(repo,'config','user.email','orch-test@example.invalid');git(repo,'config','user.name','Orch Test');writeFileSync(join(repo,'tracked.txt'),'base\n');git(repo,'add','tracked.txt');git(repo,'commit','-m','fixture');return repo}
test('the watch set is the run\'s own project plus the caller checkout, never a third project', async () => {
    const { checkoutWatchSet } = await import('./checkout-identity.ts')
    const one = repository()
    const two = repository()
    upsertProject({ name: 'own-project', path: one })
    upsertProject({ name: 'third-project', path: two })
    const caller = repository()
    const own = checkoutWatchSet([{ project: 'own-project', path: caller }], undefined, 'own-project').watched
      .map((checkout) => checkout.path)
    expect(own).toContain(realpathSync(one))
    expect(own).toContain(realpathSync(caller))
    expect(own).not.toContain(realpathSync(two))
    // No resolved project keeps the wide set: an unregistered caller has no
    // narrower fact to stand on.
    const wide = checkoutWatchSet([], undefined, null).watched.map((checkout) => checkout.path)
    expect(wide).toContain(realpathSync(one))
    expect(wide).toContain(realpathSync(two))
  })
})
