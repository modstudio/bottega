// concern: workflows
/** Declares workflow floor names and their operator-facing evidence guidance. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const floorKinds = [
  'ruling',
  'command-exit',
  'recorded-artifact',
  'class-measured',
  'tracker-transition',
  'task-open-with-notes',
  'descendants-closed',
  'review-owed',
] as const
export type FloorKind = (typeof floorKinds)[number]

export const ARTIFACT_FORMS =
  'doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | <KEY>/<n> | task:<KEY> | task:<KEY>#comment:<id> | note:<record-id|label> | run number or run id | probe:<id> | exec:<id> | review-read:<UUID> | attached-text:<UUID> | #<pull request number> | GitHub pull-request link | a commit SHA'

export const floorGuidance = {
  ruling: `call \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), answer it with \`rule_workflow\`, then pass \`--ruling <the returned question id>\`; where you rule the step yourself, pass \`self_ruling\` with \`self_ruling_basis\` (or \`--self-ruling <text>\` with \`--basis <text>\`) on the closing call`,
  'command-exit': `run it with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass \`--artifact exec:<id>\`, pass \`--gate <gate execution id>\` for a gate floor, or pass \`--run <run id>\` for a run-backed command`,
  'recorded-artifact': `record or attach the artifact and pass \`--artifact <${ARTIFACT_FORMS}>\``,
  'class-measured': `run the class-wide command with \`${PLATFORM_SLUG} workflow exec -- <command>\`, then pass exactly one \`--artifact exec:<id>\` and \`--class "<class name>"\``,
  'tracker-transition': 'make the tracker transition and pass `--task <KEY>`',
  'task-open-with-notes':
    'leave the task open, then pass `--task <KEY>` and at least one `--artifact note:<record-id|label>` for an open note attached to that task',
  'descendants-closed':
    'finish or drop every descendant, move the epic to done, and pass `--task <KEY>`',
  'review-owed': `run \`${PLATFORM_SLUG} review tier <branch>\` and follow its remedy until no lens is owed`,
} satisfies Record<FloorKind, string>

export function trackerTransitionTaskRemedy(key: string): string {
  return floorGuidance['tracker-transition'].replace('<KEY>', key)
}

export function evidenceGuidance(
  kind: FloorKind,
  operatorRuling: boolean,
  hasOtherFloor = false,
): string {
  if (kind === 'ruling' && operatorRuling)
    return `only the operator's answer closes this floor: ask with \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), have the operator answer, or relay the operator's answer with \`rule_workflow\` \`from_operator\` (or \`${PLATFORM_SLUG} workflow rule --from-operator\`), then pass \`--ruling <the returned question id>\`${hasOtherFloor ? "; another floor's evidence closes this step instead (any one floor is enough)" : ''}`
  return floorGuidance[kind]
}

export function isFloorKind(value: string): value is FloorKind {
  return floorKinds.some((kind) => kind === value)
}
