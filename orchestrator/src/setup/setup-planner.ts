// concern: setup-planner
/** Resolves setup answers into ordered project-register actions. Pure: it never applies them. */
import type { ProjectSettings } from '../project/projects.ts'
import type { SetupPlan, SetupProposal, SetupQuestion } from './setup-engine.ts'
import type { HarnessName, McpServer } from './setup-mcp.ts'
import { INFERRED_RECIPE_PATH } from './setup-toolchain.ts'

export type SetupAnswers = Record<string, string>
type SettingsDiff = Record<string, { from: unknown; to: unknown }>
type SetupActionBase = {
  path: string
  settingsDiff: SettingsDiff
  recipeFile?: { path: string; content: string }
}
export type SetupAction =
  | (SetupActionBase & {
      kind: 'add'
      name: string
      stack: string | null
      settings: ProjectSettings
    })
  | (SetupActionBase & {
      kind: 'set'
      currentName: string
      fill: { stack?: string; settings: ProjectSettings }
    })
  | (SetupActionBase & {
      kind: 'unchanged'
      name: string
    })
  | {
      kind: 'register-mcp'
      harness: HarnessName
      bin: string
      server: McpServer
      replace: boolean
    }
  | {
      kind: 'mcp-unchanged' | 'mcp-skipped'
      harness: HarnessName
      bin: string
      server: McpServer
    }

export function setupActionChangesMachine(action: SetupAction): boolean {
  switch (action.kind) {
    case 'add':
    case 'set':
    case 'register-mcp':
      return true
    case 'unchanged':
    case 'mcp-unchanged':
    case 'mcp-skipped':
      return false
  }
}

export function validateSetupAnswers(questions: SetupQuestion[], value: unknown): SetupAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('answers must be a JSON object mapping question id to option id')
  }
  const answers = value as Record<string, unknown>
  const known = new Map(questions.map((question) => [question.id, question]))
  for (const id of Object.keys(answers)) {
    if (!known.has(id)) throw new Error(`unknown answer id ${JSON.stringify(id)}`)
  }
  for (const question of questions) {
    if (!Object.hasOwn(answers, question.id)) {
      throw new Error(`missing answer for ${JSON.stringify(question.id)}`)
    }
    const answer = answers[question.id]
    if (typeof answer !== 'string' || !question.options.some((option) => option.id === answer)) {
      throw new Error(
        `invalid option for ${JSON.stringify(question.id)}: ${JSON.stringify(answer)}; expected one of ${question.options.map((option) => option.id).join(', ')}`,
      )
    }
  }
  return answers as SetupAnswers
}

function resolvedSettings(
  proposal: SetupProposal,
  answers: SetupAnswers,
  questions: SetupQuestion[],
): ProjectSettings {
  const settings = { ...proposal.project.settings }
  if (proposal.prefixQuestionId) {
    const answer = answers[proposal.prefixQuestionId]
    if (!answer) throw new Error(`missing answer for ${JSON.stringify(proposal.prefixQuestionId)}`)
    settings.keyPrefixes = [answer]
  }
  if (proposal.trunkQuestionId) {
    const trunkQuestionId = proposal.trunkQuestionId
    const question = questions.find((candidate) => candidate.id === trunkQuestionId)
    const option = question?.options.find((candidate) => candidate.id === answers[trunkQuestionId])
    // The engine owns what a choice means; ids are only stable answer handles.
    const effect = option?.effect
    if (effect?.trunk === null) delete settings.trunk
    else if (effect) settings.trunk = effect.trunk
  }
  if (
    proposal.recipeQuestionId &&
    answers[proposal.recipeQuestionId] === proposal.recipeActivationAnswer
  ) {
    settings.worktree = { ...settings.worktree, recipePath: INFERRED_RECIPE_PATH }
  }
  return settings
}

function diffSettings(current: ProjectSettings | null, proposed: ProjectSettings): SettingsDiff {
  const diff: SettingsDiff = {}
  for (const [key, to] of Object.entries(proposed)) {
    const from = current?.[key as keyof ProjectSettings] ?? null
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to }
  }
  return diff
}

export function planSetupActions(plan: SetupPlan, answers: SetupAnswers): SetupAction[] {
  const registrations: SetupAction[] = plan.registrations.map((proposal) => {
    if (proposal.state === 'same') return { ...proposal, kind: 'mcp-unchanged' }
    const answer = proposal.questionId ? answers[proposal.questionId] : undefined
    const apply = proposal.state === 'absent' ? answer === 'register' : answer === 'replace'
    if (!apply) return { ...proposal, kind: 'mcp-skipped' }
    return { ...proposal, kind: 'register-mcp', replace: proposal.state !== 'absent' }
  })
  const projects: SetupAction[] = plan.proposals.map((proposal) => {
    const settings = resolvedSettings(proposal, answers, plan.questions)
    const settingsDiff = diffSettings(proposal.current?.settings ?? null, settings)
    const metadataDiffers = Boolean(
      proposal.current && proposal.current.stack === null && proposal.project.stack !== null,
    )
    const recipeFile =
      proposal.recipeQuestionId &&
      answers[proposal.recipeQuestionId] === 'write' &&
      proposal.recipeContent
        ? { path: INFERRED_RECIPE_PATH, content: proposal.recipeContent }
        : undefined
    if (!proposal.current) {
      return {
        kind: 'add',
        name: proposal.project.name,
        path: proposal.project.path,
        stack: proposal.project.stack,
        settings,
        settingsDiff,
        ...(recipeFile ? { recipeFile } : {}),
      }
    }
    if (metadataDiffers || Object.keys(settingsDiff).length) {
      const fillSettings = Object.fromEntries(
        Object.entries(settingsDiff).map(([key, change]) => [
          key,
          key === 'worktree' &&
          (recipeFile ||
            (change.to as ProjectSettings['worktree'] | undefined)?.recipePath ===
              INFERRED_RECIPE_PATH) &&
          !proposal.current?.settings.worktree?.recipePath
            ? { recipePath: INFERRED_RECIPE_PATH }
            : change.to,
        ]),
      ) as ProjectSettings
      return {
        kind: 'set',
        currentName: proposal.current.name,
        path: proposal.project.path,
        fill: {
          ...(metadataDiffers && proposal.project.stack ? { stack: proposal.project.stack } : {}),
          settings: fillSettings,
        },
        settingsDiff,
        ...(recipeFile ? { recipeFile } : {}),
      }
    }
    return {
      kind: 'unchanged',
      name: proposal.project.name,
      path: proposal.project.path,
      settingsDiff,
    }
  })
  return [...registrations, ...projects]
}

export function recommendedAnswers(plan: SetupPlan): SetupAnswers {
  return Object.fromEntries(
    plan.questions.map((question) => [question.id, question.recommendation]),
  )
}
