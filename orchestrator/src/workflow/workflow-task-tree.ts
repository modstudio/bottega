// concern: workflows
/** Pure parent-key traversal shared by epic floors and lazy child work. */

export type ParentKeyFact = { key: string; parentKey: string | null }

export function descendantTaskKeys(rootKey: string, tasks: readonly ParentKeyFact[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const task of tasks) {
    if (!task.parentKey) continue
    children.set(task.parentKey, [...(children.get(task.parentKey) ?? []), task.key])
  }
  const descendants = new Set<string>()
  const visit = (key: string) => {
    for (const child of children.get(key) ?? []) {
      if (child === rootKey || descendants.has(child)) continue
      descendants.add(child)
      visit(child)
    }
  }
  visit(rootKey)
  return descendants
}

export function ancestorTaskKeys(key: string, tasks: readonly ParentKeyFact[]): string[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const ancestors: string[] = []
  let parent = byKey.get(key)?.parentKey ?? null
  while (parent && parent !== key && !ancestors.includes(parent)) {
    ancestors.push(parent)
    parent = byKey.get(parent)?.parentKey ?? null
  }
  return ancestors
}
