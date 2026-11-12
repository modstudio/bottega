export type ArchitectureViolationEdge = { rule: string; from: string; to: string }
type ArchitectureViolationBaseline = ArchitectureViolationEdge & { reason: string }

export const architectureViolationBaseline: readonly ArchitectureViolationBaseline[] = [
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/hosted-write-destination.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'owner-routed write; project rows use their declared membership destination and project-less rows use the personal space',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/workflow/workflows.ts',
    to: 'orchestrator/src/project-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/workflow/workflow-read-space.ts',
    to: 'orchestrator/src/project-space.ts',
    reason:
      'viewing read; reclassified when DEV-2244 splits the viewing default from the write decision',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/workflow/step-catalogue.ts',
    to: 'orchestrator/src/project-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-settings.ts',
    to: 'shared/personal-item-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-config.ts',
    to: 'shared/personal-item-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-cache.ts',
    to: 'orchestrator/src/project-space.ts',
    reason:
      'viewing read; reclassified when DEV-2244 splits the viewing default from the write decision',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-cache-feed.ts',
    to: 'orchestrator/src/project-space.ts',
    reason:
      'viewing read; reclassified when DEV-2244 splits the viewing default from the write decision',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-api.ts',
    to: 'shared/personal-item-space.ts',
    reason:
      'viewing read; reclassified when DEV-2244 splits the viewing default from the write decision',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-api-doc-tenant.ts',
    to: 'shared/personal-item-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/record/record-api-doc-order.ts',
    to: 'shared/personal-item-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/project/project-commands.ts',
    to: 'orchestrator/src/project-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/porting/porting.ts',
    to: 'orchestrator/src/project-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/porting/porting-hosted-import.ts',
    to: 'orchestrator/src/project-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/lens/lenses.ts',
    to: 'orchestrator/src/project-space.ts',
    reason: 'write path; DEV-2240 routes it by owner (S3 to S6)',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    to: 'orchestrator/src/project-space.ts',
    reason:
      'viewing read; reclassified when DEV-2244 splits the viewing default from the write decision',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/task-push.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'mixed; writes route project rows to their declared space and project-less rows to the personal space, while task pulls seed a viewing read from the active space',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/task-prune-foreign.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'owner-routed write; the project destination comes only from declarations and memberships',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/outbox.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'owner-routed write; project rows use their declared membership destination and project-less rows use the personal space',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/note-staleness-store.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'owner-routed write; note maintenance rows carry a project and use its declared membership destination',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/note-push.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'owner-routed write; note and counter rows carry a project and use its declared membership destination',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/note-project-space.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'owner-routed write; the project destination comes only from declarations and memberships',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/interval-project-correction.ts',
    to: 'hub/src/task-project-space.ts',
    reason: 'type-only import; it has no runtime active-space dependency',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/hosted-task-change-family.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'viewing read; task pull spaces include the active space, and project destinations classify changes without selecting a write fallback',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/hosted-send-change-family.ts',
    to: 'hub/src/task-project-space.ts',
    reason: 'type-only import; it has no runtime active-space dependency',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/hosted-change-family.ts',
    to: 'hub/src/task-project-space.ts',
    reason: 'type-only import; it has no runtime active-space dependency',
  },
  {
    rule: 'no-active-space-resolver-import',
    from: 'hub/src/hosted-change-cache.ts',
    to: 'hub/src/task-project-space.ts',
    reason:
      'viewing read; project destinations classify cached changes from declarations and memberships without selecting a write fallback',
  },
]

function edgeKey(edge: ArchitectureViolationEdge) {
  return JSON.stringify([edge.rule, edge.from, edge.to])
}

export function architectureViolationRatchet(current: readonly ArchitectureViolationEdge[]) {
  const baseline = new Map(architectureViolationBaseline.map((edge) => [edgeKey(edge), edge]))
  const currentKeys = new Set(current.map(edgeKey))
  return {
    newViolations: current.filter((edge) => !baseline.has(edgeKey(edge))),
    fixedBaseline: architectureViolationBaseline.filter((edge) => !currentKeys.has(edgeKey(edge))),
  }
}
