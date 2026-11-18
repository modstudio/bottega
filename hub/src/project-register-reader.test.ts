import '../test/preload.ts'
import { expect, spyOn, test } from 'bun:test'
import { projectList } from './orch-project-register.ts'
import { installProjectRegisterReader } from './project-register-reader.ts'
import { projects, refreshProjects } from './projects.ts'

test('an installed project-register reader is used without spawning', () => {
  const spawn = spyOn(Bun, 'spawnSync')
  try {
    installProjectRegisterReader(() => [
      {
        record_id: '00000000-0000-4000-8000-000000000001',
        name: 'installed',
        path: '/fixtures/repos/installed',
        stack: 'typescript',
        canon: true,
        repository: true,
        settings: {},
      },
    ])
    refreshProjects()

    expect(projects()).toEqual([
      expect.objectContaining({ name: 'installed', path: '/fixtures/repos/installed' }),
    ])
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    installProjectRegisterReader(projectList)
    refreshProjects()
    spawn.mockRestore()
  }
})
