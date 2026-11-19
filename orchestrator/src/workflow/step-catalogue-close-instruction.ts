// concern: workflows
/** Judges authored close instructions against their declared floors and cursor task. */
import type { FloorEntry } from './step-catalogue-definition.ts'
import {
  type FloorKind,
  flagForFloor,
  floorGuidance,
  floorKinds,
  isFloorKind,
} from './workflow-floor.ts'

type UnsupportedCloseEvidenceFlag = {
  flag: string
  acceptingFloors: FloorKind[]
}

const CURSOR_TASK_KEY_PLACEHOLDER = '{{key}}'
const ESCAPED_CURSOR_TASK_KEY_PLACEHOLDER = CURSOR_TASK_KEY_PLACEHOLDER.replace(
  /[.*+?^${}()|[\]\\]/g,
  '\\$&',
)
const CLOSE_INSTRUCTION_TASK_TARGET = new RegExp(
  `(?:--task(?:=|\\s+)|\\btask:)(${ESCAPED_CURSOR_TASK_KEY_PLACEHOLDER}|<[^>\\r\\n]+>|[A-Za-z0-9][A-Za-z0-9_-]*)`,
  'g',
)

export type CloseInstructionDecision =
  | { judged: false }
  | { judged: true; findings: UnsupportedCloseEvidenceFlag[] }

const evidenceFlagsByFloor = new Map(
  floorKinds.map((floor) => [
    floor,
    new Set(`${floorGuidance[floor]} ${flagForFloor(floor)}`.match(/--[a-z][a-z-]*/g) ?? []),
  ]),
)

const acceptingFloorsByFlag = new Map<string, FloorKind[]>()
for (const floor of floorKinds) {
  for (const flag of evidenceFlagsByFloor.get(floor) ?? []) {
    const accepting = acceptingFloorsByFlag.get(flag) ?? []
    accepting.push(floor)
    acceptingFloorsByFlag.set(flag, accepting)
  }
}

function closingSentences(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.match(/[^.!?]*(?:[.!?](?=\s|$)|$)/g) ?? [])
    .filter((sentence) =>
      /\b(?:close|closing|finish|finished|finishes|finishing|complete|completed|completes|completing)\b/i.test(
        sentence,
      ),
    )
}

function closeInstructionFlags(sentence: string): string[] {
  return (sentence.match(/--[a-z][a-z-]*/g) ?? []).filter((flag) => acceptingFloorsByFlag.has(flag))
}

function closeInstructionTaskTargets(sentence: string): string[] {
  return [...sentence.matchAll(CLOSE_INSTRUCTION_TASK_TARGET)].map((match) => match[1]!)
}

function workflowCloseCommandSentences(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.match(/[^.!?]*(?:[.!?](?=\s|$)|$)/g) ?? [])
    .filter((sentence) => /\bworkflow\s+(?:next|handoff)\b/.test(sentence))
}

export function unsupportedCloseEvidenceFlags(
  declaredFloors: readonly FloorEntry[],
  body: string,
): CloseInstructionDecision {
  // A templated floor resolves only at composition, so the authored text cannot be judged here.
  if (declaredFloors.some((floor) => !isFloorKind(floor))) return { judged: false }
  const named = new Set(closingSentences(body).flatMap(closeInstructionFlags))
  const findings: UnsupportedCloseEvidenceFlag[] = []
  for (const flag of named) {
    const acceptingFloors = acceptingFloorsByFlag.get(flag)
    if (!acceptingFloors) continue
    if (declaredFloors.some((floor) => acceptingFloors.includes(floor as FloorKind))) continue
    findings.push({ flag, acceptingFloors: [...acceptingFloors] })
  }
  return {
    judged: true,
    findings: findings.sort((left, right) => left.flag.localeCompare(right.flag)),
  }
}

export function closeInstructionTaskTargetErrors(item: Record<string, unknown>): string[] {
  if (typeof item.body !== 'string') return []
  const slug = String(item.slug ?? '')
  const targetSentences = [
    ...closingSentences(item.body),
    ...workflowCloseCommandSentences(item.body),
  ]
  return [...new Set(targetSentences.flatMap(closeInstructionTaskTargets))].flatMap((target) =>
    target === CURSOR_TASK_KEY_PLACEHOLDER
      ? []
      : [
          `step "${slug}" close instruction names task "${target}"; name the cursor task with ${CURSOR_TASK_KEY_PLACEHOLDER}`,
        ],
  )
}
