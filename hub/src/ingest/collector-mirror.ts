import { persistTaskAdoptions, type TaskAdoption } from '../task-adoption.ts'
import { hostedMirrorTasks } from '../task-client.ts'

export async function mirrorCollectedTasks(body: unknown) {
  const response = await hostedMirrorTasks(body)
  persistTaskAdoptions(
    (response.adoptions ?? []).filter(
      (adoption): adoption is TaskAdoption => adoption.table === 'task',
    ),
  )
  return response
}
