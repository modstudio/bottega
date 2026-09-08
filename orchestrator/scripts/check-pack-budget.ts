import { CanonBudgetError, compilePack } from '../src/canon.ts'
import { JOBS } from '../src/jobs.ts'
import { projects } from '../src/projects.ts'

export function checkPackBudget(): string[] {
  const failures: string[] = []
  for (const project of projects()) {
    for (const job of Object.keys(JOBS)) {
      try { compilePack({ job, cwd: project.path }) }
      catch (error) {
        if (error instanceof CanonBudgetError) failures.push(`${project.name}/${job}\n${error.message}`)
        else throw error
      }
    }
  }
  return failures
}

if (import.meta.main) {
  const failures = checkPackBudget()
  if (failures.length) {
    console.error(`canon pack budget failed for ${failures.length} project/job combination(s):\n${failures.join('\n\n')}`)
    process.exit(1)
  }
  console.log('canon pack budget ok')
}
