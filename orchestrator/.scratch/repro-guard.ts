import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerGitConfigEnvironment } from '../src/run/run-git-guard.ts'

const repoRoot = mkdtempSync(join(tmpdir(), 'orch-repro-guard-'))
const path = join(repoRoot, '.claude', 'worktrees', 'orch-939')
const run = (args: string[], cwd: string, env?: Record<string,string>) => {
  const p = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
console.log(run(['init', '--initial-branch=main'], repoRoot).code)
console.log(run(['-c','user.name=Orch Test','-c','user.email=orch@example.invalid','commit','--allow-empty','-m','initial'], repoRoot).code)
console.log(run(['worktree','add','-b','DEV-939-writer',path], repoRoot).code)
writeFileSync(join(path, '.orch-run'), `939\n${repoRoot}\nsource: worktree\n`)
const environment = workerGitConfigEnvironment({ path, branch:'DEV-939-writer', base:'HEAD', repoRoot, source:'git' } as any, true, 'implement')!
const workerEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repoRoot, ...environment } as Record<string,string>
console.log('CLEAN', JSON.stringify(run(['-c','user.name=Orch Test','-c','user.email=orch@example.invalid','commit','--allow-empty','-m','message without a project task key'], path, workerEnv), null, 2))
