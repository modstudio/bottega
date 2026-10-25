// concern: project-settings-refusals
/**
 * Owns the refusals about one stored project settings value: the vocabulary,
 * shape and mode checks that are not the injection grammar those settings
 * feed. Pure over plain values, so the register service can judge a row with
 * no store in hand.
 *
 * One refusal here is not about the value at all: a NAME this binary does not
 * know, in a map whose keys are a catalogue (check names, search fields, the
 * main-stack keys, the fields of a comment-history declaration). A write
 * refuses such a name, because that is how a typo in `--settings` is caught;
 * a read drops it, because a newer binary may have written one and reading the
 * register in an older tree is ordinary. Checks on a name or a value this
 * binary knows are identical in both modes.
 */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { repositoryVisibility } from '../../../shared/repository-visibility.ts'
import { GATE_INPUTS } from '../gate/gate-decision.ts'
import { validateAutonomySettings } from '../workflow/autonomy.ts'
import type { SettingsObjectMode } from './project-injection.ts'
import type { ProjectSettings } from './project-settings.ts'

/**
 * The keys of a map this binary does not know, in the mode its reader declares.
 * In strip mode a read drops them, which is why the callers build their refusals
 * from this and not from the key list itself.
 */
function unknownKeyProblems(
  keys: readonly string[],
  known: (key: string) => boolean,
  mode: SettingsObjectMode,
): string[] {
  return mode === 'strict' ? keys.filter((key) => !known(key)) : []
}

export function projectSpaceProblems(space: unknown): string[] {
  return space !== undefined && (typeof space !== 'string' || !space.trim())
    ? ['space must be a non-empty record space slug']
    : []
}

export function retiredReadonlyDockerProblems(worktree: unknown): string[] {
  if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) return []
  return Object.hasOwn(worktree, 'readonly_docker')
    ? [
        'worktree.readonly_docker is retired; remove it and read the recorded gate through gate_result',
      ]
    : []
}

export function autonomyProblems(value: unknown): string[] {
  try {
    validateAutonomySettings(value, 'project')
    return []
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

const PROJECT_CHECK_NAMES = new Set([
  'spelling',
  'attribution',
  'commentTaskKeys',
  'commentHistory',
])

export function commentHistoryProblems(value: unknown, mode: SettingsObjectMode): string[] {
  if (value === undefined || typeof value === 'boolean') return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['checks.commentHistory must be a boolean or an object with phrases']
  }
  const config = value as Record<string, unknown>
  const problems = unknownKeyProblems(Object.keys(config), (name) => name === 'phrases', mode).map(
    (name) => `checks.commentHistory.${name} is not recognized`,
  )
  if (
    !Array.isArray(config.phrases) ||
    config.phrases.some((phrase) => typeof phrase !== 'string' || !phrase.trim())
  ) {
    problems.push('checks.commentHistory.phrases must be an array of non-empty strings')
  }
  return problems
}

export function projectChecksProblems(value: unknown, mode: SettingsObjectMode): string[] {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['checks must be an object']
  }
  const checks = value as Record<string, unknown>
  const problems = unknownKeyProblems(
    Object.keys(checks),
    (name) => PROJECT_CHECK_NAMES.has(name),
    mode,
  ).map((name) => `checks.${name} is not a recognized check`)
  for (const name of ['spelling', 'attribution', 'commentTaskKeys'] as const) {
    if (checks[name] !== undefined && typeof checks[name] !== 'boolean') {
      problems.push(`checks.${name} must be a boolean`)
    }
  }
  problems.push(...commentHistoryProblems(checks.commentHistory, mode))
  return problems
}

export function managedContextProblems(value: unknown): string[] {
  return value === undefined || typeof value === 'boolean'
    ? []
    : ['managedContext must be a boolean']
}

export function canonMirrorKeyProblems(value: unknown): string[] {
  return value === undefined || (typeof value === 'string' && /^[A-Z][A-Z0-9]+-[0-9]+$/.test(value))
    ? []
    : ['canonMirrorKey must be a task key such as DEV-1002']
}

export function projectSearchProblems(value: unknown, mode: SettingsObjectMode): string[] {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['search must be an object']
  }
  const search = value as Record<string, unknown>
  const problems = unknownKeyProblems(Object.keys(search), (name) => name === 'code', mode).map(
    (name) => `search.${name} is not recognized`,
  )
  if (search.code !== undefined && typeof search.code !== 'boolean') {
    problems.push('search.code must be a boolean')
  }
  return problems
}

export function reviewLensProblems(
  review: ProjectSettings['review'],
  enabledLensIds: readonly string[] | undefined,
  enabledLensSpaceId: string | null | undefined,
): string[] {
  if (!review || !Array.isArray(review.lenses) || enabledLensIds === undefined) return []
  const enabled = new Set(enabledLensIds)
  const remedy =
    enabledLensSpaceId === undefined
      ? `choose an enabled lens from ${PLATFORM_SLUG} review lens list`
      : enabledLensSpaceId === null
        ? 'choose an enabled lens from the local catalogue (no record space)'
        : `choose an enabled lens in record space "${enabledLensSpaceId}"`
  const problems = review.lenses.flatMap((entry, index) =>
    entry && typeof entry === 'object' && typeof entry.lens === 'string' && !enabled.has(entry.lens)
      ? [`review.lenses.${index}.lens: unknown or disabled lens "${entry.lens}"; ${remedy}`]
      : [],
  )
  if (review.secondOpinion && !enabled.has(review.secondOpinion.lens)) {
    problems.push(
      `review.secondOpinion.lens: unknown or disabled lens "${review.secondOpinion.lens}"; ${remedy}`,
    )
  }
  return problems
}

function readerToolServerProblems(server: string, names: unknown): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(server)) {
    return [`mcp.reader_tools server name ${JSON.stringify(server)} must be a plain non-empty name`]
  }
  if (!Array.isArray(names)) return [`mcp.reader_tools.${server} must be a list of tool names`]
  const problems: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      problems.push(`mcp.reader_tools.${server} must contain plain non-empty tool names`)
    } else if (seen.has(name)) {
      problems.push(
        `mcp.reader_tools.${server} contains duplicate tool name ${JSON.stringify(name)}`,
      )
    }
    if (typeof name === 'string') seen.add(name)
  }
  return problems
}

export function mcpSettingsProblems(mcp: ProjectSettings['mcp']): string[] {
  if (mcp === undefined) return []
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return ['mcp must be an object']
  const problems: string[] = []
  if (mcp.probe_tool !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(mcp.probe_tool)) {
    problems.push('mcp.probe_tool must be a plain non-empty tool name')
  }
  if (!('reader_tools' in mcp)) return problems
  const readerTools = mcp.reader_tools
  if (!readerTools || typeof readerTools !== 'object' || Array.isArray(readerTools)) {
    return [...problems, 'mcp.reader_tools must be a map from server names to tool-name lists']
  }
  for (const [server, names] of Object.entries(readerTools))
    problems.push(...readerToolServerProblems(server, names))
  return problems
}

export function visibilityProblems(visibility: ProjectSettings['visibility']): string[] {
  return visibility === undefined || repositoryVisibility(visibility)
    ? []
    : ['visibility must be public or private']
}

export function gateInputProblems(gateInput: ProjectSettings['gateInput']): string[] {
  if (gateInput === undefined || GATE_INPUTS.includes(gateInput)) return []
  return ['gateInput must be staged, worktree, or committed']
}

export function mainStackProblems(
  value: ProjectSettings['mainStack'],
  mode: SettingsObjectMode,
): string[] {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['mainStack must be an object']
  }
  const unknown = unknownKeyProblems(
    Object.keys(value),
    (key) => key === 'consumers' || key === 'requiredServices',
    mode,
  )
  if (unknown.length) return ['mainStack contains unknown settings']
  if (!Array.isArray(value.consumers)) return ['mainStack.consumers must be an array']
  const allowed = new Set(['gate', 'mcp', 'worktree-create'])
  if (value.consumers.some((consumer) => typeof consumer !== 'string' || !allowed.has(consumer))) {
    return ['mainStack.consumers entries must be gate, mcp, or worktree-create']
  }
  if (new Set(value.consumers).size !== value.consumers.length) {
    return ['mainStack.consumers entries must be unique']
  }
  if (invalidOptionalStringArray(value.requiredServices)) {
    return ['mainStack.requiredServices must be an array of non-empty service names']
  }
  if (value.requiredServices?.some((service) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(service))) {
    return ['mainStack.requiredServices entries must be plain service names']
  }
  if (
    value.requiredServices &&
    new Set(value.requiredServices).size !== value.requiredServices.length
  ) {
    return ['mainStack.requiredServices entries must be unique']
  }
  return []
}

export function invalidOptionalStringArray(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim()))
  )
}
