// concern: workflow-tree-files
/** Knows workflow-tree filesystem collection and application. Must not know stores, commands, projects, runs, or transports. */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  matchWorkflowTreePath,
  WORKFLOW_STUB_DIRECTORIES,
  WORKFLOW_TREE_FOLDERS,
  WORKFLOW_TREE_ROOT,
  type WorkflowTreeFile,
  type WorkflowTreePlan,
} from './workflow-tree.ts'

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

function assertRealDirectory(path: string): void {
  const stat = lstatIfPresent(path)
  if (!stat) return
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing ${path}: not a real directory`)
  }
}

function assertWorkflowTreeDirectories(root: string): void {
  const workflows = resolve(root, WORKFLOW_TREE_ROOT)
  assertRealDirectory(workflows)
  for (const folder of WORKFLOW_TREE_FOLDERS) assertRealDirectory(resolve(workflows, folder))
  for (const directory of WORKFLOW_STUB_DIRECTORIES) {
    assertRealDirectory(resolve(root, dirname(directory)))
    assertRealDirectory(resolve(root, directory))
  }
}

function collectEntry(root: string, directory: string, name: string): WorkflowTreeFile {
  const relative = `${directory}/${name}`
  const path = resolve(root, relative)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing ${path}: not a regular file`)
  }
  if (!matchWorkflowTreePath(relative)) {
    throw new Error(`refusing ${path}: not a workflow tree file`)
  }
  return { path: relative, body: readFileSync(path, 'utf8') }
}

export function collectWorkflowTree(root: string): WorkflowTreeFile[] {
  assertWorkflowTreeDirectories(root)
  const files: WorkflowTreeFile[] = []
  const directories = [
    ...WORKFLOW_TREE_FOLDERS.map((folder) => `${WORKFLOW_TREE_ROOT}/${folder}`),
    ...WORKFLOW_STUB_DIRECTORIES,
  ]
  for (const relative of directories) {
    const directory = resolve(root, relative)
    if (!lstatIfPresent(directory)) continue
    for (const name of readdirSync(directory).sort()) files.push(collectEntry(root, relative, name))
  }
  return files
}

function assertPlanTargets(root: string, plan: WorkflowTreePlan): void {
  for (const path of [...plan.deletes, ...plan.writes.map((file) => file.path)]) {
    const target = resolve(root, path)
    const stat = lstatIfPresent(target)
    if (stat?.isSymbolicLink()) throw new Error(`refusing ${target}: existing path is a symlink`)
  }
}

export function applyWorkflowTreePlan(root: string, plan: WorkflowTreePlan): void {
  if ('refusal' in plan) {
    throw new Error(
      `refusing ${resolve(root, plan.refusal)}: workflow stub is not owned by orch workflow hydrate; rename or move that file`,
    )
  }
  assertWorkflowTreeDirectories(root)
  assertPlanTargets(root, plan)
  for (const path of plan.deletes) rmSync(resolve(root, path))
  for (const { path, body } of plan.writes) {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
}
