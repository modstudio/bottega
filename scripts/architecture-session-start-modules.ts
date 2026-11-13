// concern: architecture-manifest
/** Import boundaries for session start, kept with the session concern rather than cleanup. */

export const sessionStartBoundarySpecs = [
  {
    name: 'session-start-decision-boundary',
    file: 'orchestrator/src/session/session-start-decision.ts',
    allowed: [],
    typeOnlyAllowed: [],
    reason: 'Keep the session explore idempotence decision pure over observed cursor facts.',
  },
  {
    name: 'session-start-boundary',
    file: 'orchestrator/src/session/session-start.ts',
    allowed: [
      'bun:sqlite',
      'node:path',
      '../../../shared/brand.ts',
      '../../../shared/refusal.ts',
      '../caller-classification.ts',
      '../database/db.ts',
      '../project/projects.ts',
      '../workflow/task-flow-store.ts',
      '../workflow/workflow-cursor-live-autonomy.ts',
      '../workflow/workflow-cursor.ts',
      './session-start-decision.ts',
    ],
    typeOnlyAllowed: ['bun:sqlite'],
    reason:
      'Keep session-start composition in one adapter over project, cursor, and autonomy owners.',
  },
] as const
