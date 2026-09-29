// concern: setup-apply
/** Applies planned project actions in order through the project register service boundary. */
import type { SetupAction } from './setup-planner.ts'

type AddAction = Extract<SetupAction, { kind: 'add' }>
type SetAction = Extract<SetupAction, { kind: 'set' }>

export type SetupActionResult = SetupAction & {
  status: 'applied' | 'unchanged' | 'refused' | 'not-attempted'
  message: string | null
}

export type SetupProjectService = {
  add(input: {
    path: string
    name: string
    stack: string | null
    canon: boolean
    settings: AddAction['settings']
    allowIncomplete: boolean
  }): Promise<unknown>
  fillAbsent(input: { name: string; fill: SetAction['fill'] }): Promise<unknown>
}

export async function applySetupActions(
  actions: SetupAction[],
  service: SetupProjectService,
): Promise<SetupActionResult[]> {
  const results: SetupActionResult[] = []
  let refused = false
  for (const action of actions) {
    if (refused) {
      results.push({ ...action, status: 'not-attempted', message: null })
      continue
    }
    if (action.kind === 'unchanged') {
      results.push({ ...action, status: 'unchanged', message: null })
      continue
    }
    try {
      if (action.kind === 'add') {
        await service.add({
          path: action.path,
          name: action.name,
          stack: action.stack,
          canon: true,
          settings: action.settings,
          allowIncomplete: false,
        })
      } else {
        await service.fillAbsent({ name: action.currentName, fill: action.fill })
      }
      results.push({ ...action, status: 'applied', message: null })
    } catch (error) {
      refused = true
      results.push({
        ...action,
        status: 'refused',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
