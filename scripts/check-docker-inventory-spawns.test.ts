import { expect, test } from 'bun:test'
import { dockerInventorySpawnBypasses } from './check-docker-inventory-spawns.ts'

test('Docker inventory spawn guard refuses covered direct spawn forms', () => {
  const source = `
    Bun.${'spawnSync'}(['docker', 'ps', '-a'])
    startBoundedSync(['docker', 'volume', 'ls'])
    spawn(['docker', 'network', 'ls'])
    spawnSync(['docker', 'network', 'inspect', 'fixture'])
    spawnSync(['docker', 'volume', 'inspect', 'fixture'])
  `
  expect(dockerInventorySpawnBypasses(source, 'fixture.ts')).toHaveLength(5)
})

test('Docker inventory spawn guard permits the shared helper and unrelated commands', () => {
  const source = `
    runDockerInventoryCommand(['docker', 'ps', '-a'], 1000)
    Bun.${'spawnSync'}(['docker', 'compose', 'ps'])
    Bun.${'spawnSync'}(['git', 'status'])
  `
  expect(dockerInventorySpawnBypasses(source, 'fixture.ts')).toEqual([])
})

test('Docker inventory spawn guard permits bounded classified inventory', () => {
  const source = `
    try {
      startBoundedSync(['docker', 'network', 'ls'], { budget: 'docker' })
    } catch (error) {
      classifyDockerInventorySpawnError(error)
    }
    try {
      startBoundedSync(['docker', 'network', 'inspect', 'fixture'], { budget: 'docker' })
    } catch (error) {
      classifyDockerInventorySpawnError(error)
    }
    try {
      startBoundedSync(['docker', 'volume', 'ls'], { budget: 'docker' })
    } catch (error) {
      classifyDockerInventorySpawnError(error)
    }
  `
  expect(
    dockerInventorySpawnBypasses(source, 'orchestrator/src/monitor/monitor-conditions.ts'),
  ).toEqual([])
})

test('Docker inventory spawn guard refuses unclassified or incorrectly budgeted network inventory', () => {
  const source = `
    try {
      startBoundedSync(['docker', 'network', 'ls'], { budget: 'git-plumbing' })
    } catch (error) {
      classifyDockerInventorySpawnError(error)
    }
    startBoundedSync(['docker', 'network', 'ls'], { budget: 'docker' })
  `
  expect(
    dockerInventorySpawnBypasses(source, 'orchestrator/src/resources/docker-resources.ts'),
  ).toHaveLength(2)
})

test('Docker inventory spawn guard follows a same-scope const argv binding', () => {
  const source = `
    function inventory() {
      const command = ['docker', 'ps', '-a']
      Bun.spawnSync(command)
    }
  `
  expect(
    dockerInventorySpawnBypasses(source, 'orchestrator/src/resources/main-stack.ts'),
  ).toHaveLength(1)
})

test('Docker inventory spawn guard refuses a bare monitor volume inventory', () => {
  expect(
    dockerInventorySpawnBypasses(
      `Bun.spawnSync(['docker', 'volume', 'ls'])`,
      'orchestrator/src/monitor/monitor-conditions.ts',
    ),
  ).toHaveLength(1)
})
