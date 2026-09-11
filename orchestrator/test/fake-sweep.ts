import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
import { sweepRuns } from '../src/cleanup-sweep.ts'

/** Runs the sweep service with captured presentation and a scoped process environment. */
export async function runSweep(
  env: Record<string, string> = {}, ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const prior = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  const executable = (name: string) =>
    (process.env.PATH ?? '').split(':').map((entry) => join(entry, name)).find(existsSync)
  const docker = executable('docker')
  const ps = executable('ps')
  const originalSpawn = Bun.spawnSync
  const spawn = docker ? spyOn(Bun, 'spawnSync').mockImplementation(((command: string[], options: any) =>
    command[0] === 'docker'
      ? originalSpawn([docker!, ...command.slice(1)], { ...options, env: process.env })
      : command[0] === 'ps' && ps
        ? originalSpawn([ps, ...command.slice(1)], { ...options, env: process.env })
      : originalSpawn(command, options)) as typeof Bun.spawnSync) : null
  const out: string[] = []
  const err: string[] = []
  let code = 0
  const projectIndex = args.indexOf('--project')
  const trustHeadings = () => {
    const path = process.env.GROK_HOME && join(process.env.GROK_HOME, 'trusted_folders.toml')
    return path && existsSync(path)
      ? readFileSync(path, 'utf8').split('\n').filter((line) => /^\[folders\.["']/.test(line))
      : []
  }
  try {
    await sweepRuns({
      dryRun: args.includes('--dry-run'), force: args.includes('--force'),
      project: projectIndex >= 0 ? args[projectIndex + 1] : undefined,
      presentation: {
        log: (...values) => out.push(values.join(' ')),
        error: (...values) => err.push(values.join(' ')),
        setExitCode: (value) => { code = value },
        keptBranchLine: (branch, unique, after, id) =>
          `kept branch ${branch}: ${unique} unique commit(s)${after === null ? '' : `, ${after} after cut`}; inspect run ${id}`,
      },
    }, {
      grokTrustHeadings: trustHeadings,
      grokTrustPathFromHeading: (heading) => heading.match(/^\[folders\.["'](.+)["']\]$/)?.[1] ?? null,
    })
    if (!args.includes('--dry-run') && err.length > 0) code = 1
  } catch (error) {
    code = 1
    err.push(error instanceof Error ? error.message : String(error))
  } finally {
    spawn?.mockRestore()
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { code, out: out.join('\n'), err: err.join('\n') }
}
