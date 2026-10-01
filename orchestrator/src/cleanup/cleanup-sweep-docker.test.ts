import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { reclaimSweptDockerResources } from './cleanup-sweep-docker.ts'

afterEach(() => {
  mock.restore()
})

test('a project-scoped sweep previews reclamation only for that project', () => {
  const alphaRun = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const bravoRun = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const alphaName = `docker-alpha-${alphaRun}`
  const bravoName = `docker-bravo-${bravoRun}`
  upsertProject({ name: alphaName, path: join(dir, alphaName), settings: {} })
  upsertProject({ name: bravoName, path: join(dir, bravoName), settings: {} })
  db().query('UPDATE run SET repo=? WHERE id=?').run(alphaName, alphaRun)
  db().query('UPDATE run SET repo=? WHERE id=?').run(bravoName, bravoRun)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a --format'))
      return result(`app-orch-${alphaRun}-web\napp-orch-${bravoRun}-web`)
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return result('', 1, `unexpected command: ${command}`)
  }) as typeof Bun.spawnSync)
  const lines: string[] = []

  const failed = reclaimSweptDockerResources({
    dryRun: true,
    selectedProject: projectByName(alphaName)!,
    presentation: presentation(lines),
    inventoryErrors: new Set(),
    leaked: new Map(),
  })

  expect(failed).toBeFalse()
  expect(lines).toContain(`would tear down disposable Docker resources for run ${alphaRun}`)
  expect(lines.join('\n')).not.toContain(`run ${bravoRun}`)
  expect(commands.filter((command) => command.startsWith('docker '))).toHaveLength(3)
})

test('an unattributable worktree resource is an observation, not a sweep failure', () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const name = `docker-observation-${run}`
  const path = join(dir, name)
  upsertProject({ name, path, settings: {} })
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format'))
      return result(`custom-stack\t\tcustom\t${path}/.claude/worktrees/ADN-1001-feature`)
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return result('', 1, `unexpected command: ${command}`)
  }) as typeof Bun.spawnSync)
  const lines: string[] = []

  const failed = reclaimSweptDockerResources({
    dryRun: false,
    selectedProject: projectByName(name)!,
    presentation: presentation(lines),
    inventoryErrors: new Set(),
    leaked: new Map(),
  })

  expect(failed).toBeFalse()
  expect(lines.join('\n')).toContain('unattributable worktree Docker container custom-stack')
})

function presentation(lines: string[]): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    setExitCode: () => undefined,
    keptBranchLine: () => '',
  }
}

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
