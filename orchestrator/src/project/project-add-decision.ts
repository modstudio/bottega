// concern: project-add-decision
/** Decides whether project registration adopts, creates, or refuses without performing I/O. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import {
  hostedProjectColumns,
  PROJECT_SETTING_COLUMNS,
  PROJECT_SETTINGS_NOT_IMPORTED,
} from '../record/record-project-columns.ts'
import {
  noActiveRecordSpaceRefusal,
  projectRecordDestination,
} from '../record/record-project-destination.ts'
import type { ProjectSettings } from './project-settings.ts'

export type AddHostedProject = RecordProject

type AddProjectDecision =
  | { kind: 'mint'; settings: ProjectSettings }
  | {
      kind: 'adopt'
      recordId: string
      stack: string | null
      settings: ProjectSettings
      space: string
    }
  | { kind: 'refuse'; reason: string }

export type ProjectAddDecisionResult = {
  decision: AddProjectDecision
  targetSpace?: { id: string; label: string }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hostedSettingDiffs(requested: ProjectSettings, hosted: ProjectSettings): string[] {
  const hostedColumns = hostedProjectColumns(hosted, 'hosted')
  const requestedColumns = hostedProjectColumns(requested, 'requested')
  const localOnly = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
  return Object.keys(requested)
    .filter((key) => !localOnly.has(key))
    .filter((key) => {
      const column = PROJECT_SETTING_COLUMNS[key as keyof typeof PROJECT_SETTING_COLUMNS]
      if (key === 'mcp') {
        return (
          stable(hostedColumns.mcpProbeTool) !== stable(requestedColumns.mcpProbeTool) ||
          stable(hostedColumns.mcpReaderTools) !== stable(requestedColumns.mcpReaderTools)
        )
      }
      return stable(hostedColumns[column]) !== stable(requestedColumns[column])
    })
}

function spaceLabel(
  spaceId: string,
  memberships: readonly RecordSpaceMembership[],
  fallback: string,
): string {
  return memberships.find((membership) => membership.spaceId === spaceId)?.slug ?? fallback
}

function decideHostedAdoption(input: {
  name: string
  requestedStack: string | null
  stackWasRequested: boolean
  requestedSettings: ProjectSettings
  hosted: AddHostedProject
  declaredMembership?: RecordSpaceMembership
  memberships: readonly RecordSpaceMembership[]
}): Exclude<AddProjectDecision, { kind: 'mint' }> {
  const { hosted } = input
  if (!hosted.settings) {
    return {
      kind: 'refuse',
      reason:
        'the hosted record server predates project adoption; release the record API, then retry',
    }
  }
  const differing = hostedSettingDiffs(input.requestedSettings, hosted.settings as ProjectSettings)
  if (input.stackWasRequested && input.requestedStack !== hosted.stack) differing.unshift('stack')
  if (input.declaredMembership && input.declaredMembership.spaceId !== hosted.spaceId) {
    differing.push('space')
  }
  if (differing.length) {
    return {
      kind: 'refuse',
      reason: `requested project settings differ from the hosted row: ${[...new Set(differing)].join(', ')}; add the project without those settings, then run \`${PLATFORM_SLUG} project set ${input.name}\``,
    }
  }

  const localOnly = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
  const requestedLocal = Object.fromEntries(
    Object.entries(input.requestedSettings).filter(([key]) => localOnly.has(key)),
  ) as ProjectSettings
  const space = spaceLabel(hosted.spaceId, input.memberships, hosted.spaceId)
  return {
    kind: 'adopt',
    recordId: hosted.id,
    stack: hosted.stack,
    settings: { ...(hosted.settings as ProjectSettings), ...requestedLocal, space },
    space,
  }
}

function decideMint(
  input: {
    name: string
    requestedSettings: ProjectSettings
    memberships: readonly RecordSpaceMembership[]
    activeSpaceId: string | null
  },
  selectedMembership: RecordSpaceMembership | undefined,
  declaredMembership: RecordSpaceMembership | undefined,
): ProjectAddDecisionResult {
  const declaredSpace = selectedMembership?.spaceId ?? declaredMembership?.spaceId ?? null
  if (!declaredSpace && !input.activeSpaceId) {
    return { decision: { kind: 'refuse', reason: noActiveRecordSpaceRefusal() } }
  }
  const destination = projectRecordDestination(
    input.name,
    declaredSpace,
    input.activeSpaceId ?? '',
    input.memberships,
  )
  if ('refused' in destination) {
    throw new Error(
      `resolved project destination unexpectedly refused ${destination.declaredSpace}`,
    )
  }
  return {
    decision: {
      kind: 'mint',
      settings: selectedMembership
        ? { ...input.requestedSettings, space: selectedMembership.slug }
        : input.requestedSettings,
    },
    targetSpace: {
      id: destination.spaceId,
      label: spaceLabel(destination.spaceId, input.memberships, destination.spaceId),
    },
  }
}

export function decideProjectAdd(input: {
  name: string
  requestedStack: string | null
  stackWasRequested: boolean
  requestedSettings: ProjectSettings
  selectedSpace?: string
  hostedProjects: readonly AddHostedProject[]
  memberships: readonly RecordSpaceMembership[]
  activeSpaceId: string | null
}): ProjectAddDecisionResult {
  const selectedMembership = input.selectedSpace
    ? recordSpaceMembership(input.selectedSpace, input.memberships)
    : undefined
  if (input.selectedSpace && !selectedMembership) {
    return {
      decision: {
        kind: 'refuse',
        reason: `the signed-in user is not a member of record space ${input.selectedSpace}`,
      },
    }
  }
  const declaredMembership = input.requestedSettings.space
    ? recordSpaceMembership(input.requestedSettings.space, input.memberships)
    : undefined
  if (
    selectedMembership &&
    input.requestedSettings.space &&
    declaredMembership?.spaceId !== selectedMembership.spaceId
  ) {
    return {
      decision: {
        kind: 'refuse',
        reason: '--space and settings.space must name the same record space',
      },
    }
  }

  const named = input.hostedProjects.filter(
    (project) =>
      project.name === input.name &&
      (!selectedMembership || project.spaceId === selectedMembership.spaceId),
  )
  if (named.length > 1) {
    const spaces = named
      .map((project) => spaceLabel(project.spaceId, input.memberships, project.spaceName))
      .sort()
    return {
      decision: {
        kind: 'refuse',
        reason: `hosted project ${JSON.stringify(input.name)} exists in multiple record spaces: ${spaces.join(', ')}; choose one with --space <id-or-slug>`,
      },
    }
  }
  if (named.length === 0) {
    return decideMint(input, selectedMembership, declaredMembership)
  }

  const decision = decideHostedAdoption({ ...input, hosted: named[0]!, declaredMembership })
  if (decision.kind === 'refuse') return { decision }
  return {
    decision,
    targetSpace: { id: named[0]!.spaceId, label: decision.space },
  }
}
