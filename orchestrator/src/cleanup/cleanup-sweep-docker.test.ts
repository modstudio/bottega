import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { reclaimSweptDockerResources } from './cleanup-sweep-docker.ts'

afterEach(() => {
  mock.restore()
})

const runRecordId = (runId: number) =>
  db().query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?').get(runId)!
    .record_id

test('a project-scoped sweep previews reclamation only for that project', () => {
  const alphaRun = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const bravoRun = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const alphaName = `docker-alpha-${alphaRun}`
  const bravoName = `docker-bravo-${bravoRun}`
  const alphaRecordId = newRecordId()
  const bravoRecordId = newRecordId()
  upsertProject({
    recordId: alphaRecordId,
    name: alphaName,
    path: join(dir, alphaName),
    settings: {},
  })
  upsertProject({
    recordId: bravoRecordId,
    name: bravoName,
    path: join(dir, bravoName),
    settings: {},
  })
  db()
    .query('UPDATE run SET repo=?,project_record_id=? WHERE id=?')
    .run(alphaName, alphaRecordId, alphaRun)
  db()
    .query('UPDATE run SET repo=?,project_record_id=? WHERE id=?')
    .run(bravoName, bravoRecordId, bravoRun)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a --format'))
      return result(
        `app-orch-${alphaRun}-web\t${runRecordId(alphaRun)}\napp-orch-${bravoRun}-web\t${runRecordId(bravoRun)}`,
      )
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

test('a project-scoped sweep still finds Docker resources after the project is renamed', () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const oldName = `docker-before-rename-${run}`
  const newName = `docker-after-rename-${run}`
  const recordId = newRecordId()
  upsertProject({ recordId, name: oldName, path: join(dir, oldName), settings: {} })
  db().query('UPDATE run SET repo=?,project_record_id=? WHERE id=?').run(oldName, recordId, run)
  db().query('UPDATE project SET name=? WHERE record_id=?').run(newName, recordId)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format'))
      return result(`app-orch-${run}-web\t${runRecordId(run)}`)
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return result('', 1, `unexpected command: ${command}`)
  }) as typeof Bun.spawnSync)
  const lines: string[] = []

  const failed = reclaimSweptDockerResources({
    dryRun: true,
    selectedProject: projectByName(newName)!,
    presentation: presentation(lines),
    inventoryErrors: new Set(),
    leaked: new Map(),
  })

  expect(failed).toBeFalse()
  expect(lines).toContain(`would tear down disposable Docker resources for run ${run}`)
})

test('a cross-project root and child chain retains Docker resources and fails visibly', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  const alphaName = `docker-conflict-alpha-${root}`
  const bravoName = `docker-conflict-bravo-${root}`
  const alphaId = newRecordId()
  const bravoId = newRecordId()
  upsertProject({ recordId: alphaId, name: alphaName, path: join(dir, alphaName), settings: {} })
  upsertProject({ recordId: bravoId, name: bravoName, path: join(dir, bravoName), settings: {} })
  db().query('UPDATE run SET repo=?,project_record_id=? WHERE id=?').run(alphaName, alphaId, root)
  db().query('UPDATE run SET repo=?,project_record_id=? WHERE id=?').run(bravoName, bravoId, child)
  const commands: string[] = []
  mockDockerForRun(root, commands)
  const lines: string[] = []

  const failed = reclaimSweptDockerResources({
    dryRun: false,
    selectedProject: projectByName(bravoName)!,
    presentation: presentation(lines),
    inventoryErrors: new Set(),
    leaked: new Map(),
  })

  expect(failed).toBeTrue()
  expect(commands.some((command) => command.startsWith('docker rm'))).toBeFalse()
  expect(lines.join('\n')).toContain(
    `conversation root ${root} project UUID ${alphaId} does not match project ${bravoId}`,
  )
})

test('a fully NULL chain is reported instead of disappearing from project-scoped cleanup', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  const name = `docker-null-chain-${root}`
  upsertProject({ recordId: newRecordId(), name, path: join(dir, name), settings: {} })
  db()
    .query('UPDATE run SET repo=?,project_record_id=NULL WHERE id IN (?,?)')
    .run(name, root, child)
  const commands: string[] = []
  mockDockerForRun(root, commands)
  const lines: string[] = []

  const failed = reclaimSweptDockerResources({
    dryRun: false,
    selectedProject: projectByName(name)!,
    presentation: presentation(lines),
    inventoryErrors: new Set(),
    leaked: new Map(),
  })

  expect(failed).toBeTrue()
  expect(commands.some((command) => command.startsWith('docker rm'))).toBeFalse()
  expect(lines.join('\n')).toContain(`conversation root ${root} project UUID is missing`)
})

test('a matching root and child chain reclaims Docker resources', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  const name = `docker-matching-chain-${root}`
  const recordId = newRecordId()
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-docker-matching-'))
  mkdirSync(join(projectPath, '.git'))
  upsertProject({ recordId, name, path: projectPath, settings: {} })
  db()
    .query('UPDATE run SET repo=?,project_record_id=? WHERE id IN (?,?)')
    .run(name, recordId, root, child)
  const commands: string[] = []
  mockDockerForRun(root, commands)
  const lines: string[] = []

  try {
    const failed = reclaimSweptDockerResources({
      dryRun: false,
      selectedProject: projectByName(name)!,
      presentation: presentation(lines),
      inventoryErrors: new Set(),
      leaked: new Map(),
    })

    expect(failed).toBeFalse()
    expect(commands).toContain(`docker rm -f app-orch-${root}-web`)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('an unattributable worktree resource is an observation, not a sweep failure', () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const name = `docker-observation-${run}`
  const path = join(dir, name)
  upsertProject({ recordId: newRecordId(), name, path, settings: {} })
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

test('an orphan container pulls in its Compose network and volume while remnants only report', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-docker-orphan-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const gone = join(projectPath, '.claude/worktrees/DEV-1053-gone')
  const name = `docker-orphan-group-${Date.now()}`
  upsertProject({ recordId: newRecordId(), name, path: projectPath, settings: {} })
  expect(projectByName(name)?.path).toBe(projectPath)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((
    args: string[],
    options?: Parameters<typeof Bun.spawnSync>[1],
  ) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format'))
      return result(
        [
          `orphan-db\t\torphan-stack\t${gone}`,
          `mixed-dead\t\tmixed-stack\t${gone}`,
          'mixed-live\t\tmixed-stack',
          `main-db\t\tmain-stack\t${projectPath}`,
        ].join('\n'),
      )
    if (command.startsWith('docker volume ls --format'))
      return result(
        [
          'orphan_data\t\torphan-stack',
          'mixed_data\t\tmixed-stack',
          'remnant_data\t\tremnant-stack',
          'main_data\t\tmain-stack',
        ].join('\n'),
      )
    if (command === 'docker network ls --format {{.Name}}')
      return result('orphan_default\nremnant_default')
    if (command === 'docker network inspect orphan_default remnant_default')
      return result(
        JSON.stringify([
          { Name: 'orphan_default', Labels: { 'com.docker.compose.project': 'orphan-stack' } },
          { Name: 'remnant_default', Labels: { 'com.docker.compose.project': 'remnant-stack' } },
        ]),
      )
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)
  try {
    const lines: string[] = []
    const failed = reclaimSweptDockerResources({
      dryRun: true,
      selectedProject: projectByName(name)!,
      presentation: presentation(lines),
      inventoryErrors: new Set(),
      leaked: new Map(),
    })

    expect(failed).toBeFalse()
    expect(lines).toContain(
      'would remove orphan worktree Docker container orphan-db for Compose project orphan-stack',
    )
    expect(lines).toContain(
      'would remove orphan worktree Docker network orphan_default for Compose project orphan-stack',
    )
    expect(lines).toContain(
      'would remove orphan worktree Docker volume orphan_data for Compose project orphan-stack',
    )
    expect(lines).toContain(
      'would report ownerless Compose remnant remnant-stack: remnant_data, remnant_default',
    )
    expect(lines.join('\n')).not.toContain('main_data')
    expect(lines.join('\n')).not.toContain(
      'would remove orphan worktree Docker container mixed-dead',
    )
    expect(lines.join('\n')).not.toContain('would remove orphan worktree Docker volume mixed_data')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('a recorded run worktree pointer keeps an otherwise orphan Compose project', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-docker-recorded-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const gone = join(projectPath, '.claude/worktrees/DEV-1053-recorded')
  const name = `docker-recorded-group-${Date.now()}`
  upsertProject({ recordId: newRecordId(), name, path: projectPath, settings: {} })
  const run = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(gone, run)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((
    args: string[],
    options?: Parameters<typeof Bun.spawnSync>[1],
  ) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format'))
      return result(`recorded-db\t\trecorded-stack\t${gone}`)
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)
  try {
    const lines: string[] = []
    const failed = reclaimSweptDockerResources({
      dryRun: true,
      selectedProject: projectByName(name)!,
      presentation: presentation(lines),
      inventoryErrors: new Set(),
      leaked: new Map(),
    })

    expect(failed).toBeFalse()
    expect(lines.join('\n')).not.toContain('would remove orphan worktree Docker')
    expect(lines.join('\n')).toContain('unattributable worktree Docker container recorded-db')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('a cleanup lock failure is isolated and a later orphan group is still removed', () => {
  const firstPath = mkdtempSync(join(tmpdir(), 'orch-docker-lock-first-'))
  const secondPath = mkdtempSync(join(tmpdir(), 'orch-docker-lock-second-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: firstPath })
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: secondPath })
  const firstGone = join(firstPath, '.claude/worktrees/DEV-1053-first')
  const secondGone = join(secondPath, '.claude/worktrees/DEV-1053-second')
  const firstName = `docker-lock-first-${Date.now()}`
  const secondName = `docker-lock-second-${Date.now()}`
  upsertProject({ recordId: newRecordId(), name: firstName, path: firstPath, settings: {} })
  upsertProject({ recordId: newRecordId(), name: secondName, path: secondPath, settings: {} })
  const commands: string[] = []
  let hidFirstGit = false
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((
    args: string[],
    options?: Parameters<typeof Bun.spawnSync>[1],
  ) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a --format'))
      return result(
        [`first-db\t\tfirst-stack\t${firstGone}`, `second-db\t\tsecond-stack\t${secondGone}`].join(
          '\n',
        ),
      )
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    if (command === 'docker rm -f second-db') return result('')
    const response = actualSpawnSync(args, options)
    if (
      !hidFirstGit &&
      command.includes('worktree list --porcelain') &&
      options?.cwd === firstPath
    ) {
      renameSync(join(firstPath, '.git'), join(firstPath, '.git-hidden'))
      hidFirstGit = true
    }
    return response
  }) as typeof Bun.spawnSync)
  try {
    const lines: string[] = []
    const inventoryErrors = new Set<string>()
    const failed = reclaimSweptDockerResources({
      dryRun: false,
      selectedProject: null,
      presentation: presentation(lines),
      inventoryErrors,
      leaked: new Map(),
    })

    expect(failed).toBeTrue()
    expect(commands).toContain('docker rm -f second-db')
    expect(commands).not.toContain('docker rm -f first-db')
    expect([...inventoryErrors].join('\n')).toContain(
      `project ${firstName}, Compose project first-stack`,
    )
  } finally {
    if (hidFirstGit) renameSync(join(firstPath, '.git-hidden'), join(firstPath, '.git'))
    rmSync(firstPath, { recursive: true, force: true })
    rmSync(secondPath, { recursive: true, force: true })
  }
})

function presentation(lines: string[]): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    setExitCode: () => undefined,
    keptBranchLine: () => '',
  }
}

function mockDockerForRun(runId: number, commands: string[]): void {
  let removed = false
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a --format'))
      return result(removed ? '' : `app-orch-${runId}-web\t${runRecordId(runId)}`)
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    if (command === `docker rm -f app-orch-${runId}-web`) {
      removed = true
      return result('')
    }
    if (command.startsWith('git rev-parse --git-common-dir')) return result('.git')
    return result('', 1, `unexpected command: ${command}`)
  }) as typeof Bun.spawnSync)
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
