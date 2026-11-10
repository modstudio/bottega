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
import { retiredHostedProjectMessage } from './project-retired-hosted.ts'
import { type ProjectSettings, stableSettingsJson } from './project-settings.ts'
import { PROJECT_SPACE_INPUTS_MUST_MATCH } from './project-space-refusals.ts'

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
          stableSettingsJson(hostedColumns.mcpProbeTool) !==
            stableSettingsJson(requestedColumns.mcpProbeTool) ||
          stableSettingsJson(hostedColumns.mcpReaderTools) !==
            stableSettingsJson(requestedColumns.mcpReaderTools) ||
          stableSettingsJson(hostedColumns.mcpWriterTools) !==
            stableSettingsJson(requestedColumns.mcpWriterTools)
        )
      }
      return (
        stableSettingsJson(hostedColumns[column]) !== stableSettingsJson(requestedColumns[column])
      )
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
  if (hosted.retiredAt) {
    return { kind: 'refuse', reason: retiredHostedProjectMessage(input.name) }
  }
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
    requestedSettings: ProjectSettings
    memberships: readonly RecordSpaceMembership[]
  },
  selectedMembership: RecordSpaceMembership | undefined,
  declaredMembership: RecordSpaceMembership | undefined,
): ProjectAddDecisionResult {
  const declaredSpace = selectedMembership?.spaceId ?? declaredMembership?.spaceId ?? null
  if (!declaredSpace) {
    return {
      decision: {
        kind: 'refuse',
        reason: 'project add requires a record space; retry with --space <id-or-slug>',
      },
    }
  }
  return {
    decision: {
      kind: 'mint',
      settings: selectedMembership
        ? { ...input.requestedSettings, space: selectedMembership.slug }
        : input.requestedSettings,
    },
    targetSpace: {
      id: declaredSpace,
      label: spaceLabel(declaredSpace, input.memberships, declaredSpace),
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
        reason: PROJECT_SPACE_INPUTS_MUST_MATCH,
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
