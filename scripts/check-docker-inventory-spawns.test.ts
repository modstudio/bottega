import { expect, test } from 'bun:test'
import { dockerInventorySpawnBypasses } from './check-docker-inventory-spawns.ts'

test('Docker inventory spawn guard refuses covered direct spawn forms', () => {
  const source = `
    Bun.${'spawnSync'}(['docker', 'ps', '-a'])
    startBoundedSync(['docker', 'volume', 'ls'])
    spawn(['docker', 'network', 'ls'])
  `
  expect(dockerInventorySpawnBypasses(source, 'fixture.ts')).toHaveLength(3)
})

test('Docker inventory spawn guard permits the shared helper and unrelated commands', () => {
  const source = `
    runDockerInventoryCommand(['docker', 'ps', '-a'], 1000)
    Bun.${'spawnSync'}(['docker', 'compose', 'ps'])
    Bun.${'spawnSync'}(['git', 'status'])
  `
  expect(dockerInventorySpawnBypasses(source, 'fixture.ts')).toEqual([])
})

test('Docker inventory spawn guard permits bounded classified network inventory', () => {
  const source = `
    try {
      startBoundedSync(['docker', 'network', 'ls'], { budget: 'docker' })
    } catch (error) {
      executableAbsentFrom(error)
    }
  `
  expect(
    dockerInventorySpawnBypasses(source, 'orchestrator/src/resources/docker-resources.ts'),
  ).toEqual([])
})

test('Docker inventory spawn guard refuses unclassified or incorrectly budgeted network inventory', () => {
  const source = `
    try {
      startBoundedSync(['docker', 'network', 'ls'], { budget: 'git-plumbing' })
    } catch (error) {
      executableAbsentFrom(error)
    }
    startBoundedSync(['docker', 'network', 'ls'], { budget: 'docker' })
  `
  expect(
    dockerInventorySpawnBypasses(source, 'orchestrator/src/resources/docker-resources.ts'),
  ).toHaveLength(2)
})
