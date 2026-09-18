import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'

const store: WorkflowTreeStore = {
  steps: [
    {
      slug: 'verify',
      title: 'Verify',
      floor: ['command-exit'],
      job: null,
      autonomy: 'auto',
      needs: ['docs'],
      body: 'Run the gate.',
    },
  ],
  workflows: [
    {
      slug: 'ship',
      definition: {
        title: 'Ship',
        description: 'Ship the change.',
        arguments: [
          { name: 'key', required: true, description: 'Task key.' },
          { name: 'branch', required: false, description: 'Existing branch.' },
        ],
        modes: [{ slug: 'default', title: 'Ship', default: true, steps: ['verify'] }],
      },
    },
  ],
}

describe('planWorkflowHydration', () => {
  test('writes every production row into an empty tree and the resulting tree is stable', () => {
    const first = planWorkflowHydration({ store, tree: [] })
    expect(first.writes.map(({ path }) => path)).toEqual([
      '.agents/workflows/ship.md',
      '.claude/commands/ship.md',
      'workflows/flows/ship.md',
      'workflows/steps/verify.md',
    ])
    expect(planWorkflowHydration({ store, tree: first.writes })).toEqual({
      writes: [],
      deletes: [],
    })
  })

  test('renders the ownership marker, ordered argument hint, and slug-specific compose instruction', () => {
    const plan = planWorkflowHydration({ store, tree: [] })
    const stub = plan.writes.find(({ path }) => path === '.agents/workflows/ship.md')
    expect(stub?.body).toContain('argument-hint: "<key> [branch]"')
    expect(stub?.body).toContain('generated-by: orch workflow hydrate')
    expect(stub?.body).toContain('`compose_workflow` with `workflow: "ship"`')
  })

  test('renders identical bodies at both stub paths so harness copies cannot drift', () => {
    const plan = planWorkflowHydration({ store, tree: [] })
    const agents = plan.writes.find(({ path }) => path === '.agents/workflows/ship.md')
    const claude = plan.writes.find(({ path }) => path === '.claude/commands/ship.md')
    expect(agents?.body).toBe(claude?.body)
  })

  test('refuses an unmarked stub without writes so hydration cannot clobber it', () => {
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: '.claude/commands/ship.md', body: 'hand written\n' }],
      }),
    ).toEqual({ writes: [], deletes: [], refusal: '.claude/commands/ship.md' })
  })

  test('deletes only marked stubs left by workflows no longer in production', () => {
    const marked =
      '---\nname: retired\ngenerated-by: orch workflow hydrate\n---\nRetired workflow.\n'
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: '.agents/workflows/retired.md', body: marked }],
      }).deletes,
    ).toEqual(['.agents/workflows/retired.md'])
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: '.agents/workflows/retired.md', body: 'hand written\n' }],
      }),
    ).toEqual({ writes: [], deletes: [], refusal: '.agents/workflows/retired.md' })
  })

  test('deletes a tree file whose slug is absent from production', () => {
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: 'workflows/steps/obsolete.md', body: 'old' }],
      }).deletes,
    ).toEqual(['workflows/steps/obsolete.md'])
  })

  test('README.md in steps is neither parsed nor deleted and is refused at collection', () => {
    const tree = [{ path: 'workflows/steps/README.md', body: 'notes\n' }]
    expect(parseWorkflowTree(tree)).toEqual({ steps: [], workflows: [] })
    expect(planWorkflowHydration({ store, tree }).deletes).toEqual([])
    const root = mkdtempSync(join(tmpdir(), 'orch-workflow-tree-readme-'))
    try {
      mkdirSync(join(root, 'workflows', 'steps'), { recursive: true })
      writeFileSync(join(root, 'workflows', 'steps', 'README.md'), 'notes\n')
      expect(() => collectWorkflowTree(root)).toThrow(
        `refusing ${join(root, 'workflows', 'steps', 'README.md')}: not a workflow tree file`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
