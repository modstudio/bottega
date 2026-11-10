import { afterAll, beforeAll } from 'bun:test'
import { projects } from '../src/projects.ts'

/**
 * Declare a record space on one fixture project for the calling test file, and remove it after.
 * The register is cached for the whole test process, so a declaration must not outlive its file.
 */
export function declareFixtureProjectSpace(name: string, space: string): void {
  const project = () => {
    const found = projects().find((candidate) => candidate.name === name)
    if (!found) throw new Error(`fixture project ${name} is not registered`)
    return found
  }
  beforeAll(() => {
    project().settings.space = space
  })
  afterAll(() => {
    delete project().settings.space
  })
}
