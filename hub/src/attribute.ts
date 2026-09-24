import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { OrchRun } from './ingest/runs.ts'
import { type Project, projectRoot, projects } from './projects.ts'

/** Every ticket key this estate issues, resolved only when attribution first needs it. */
function keyPrefixes(): string {
  return [...new Set(projects().flatMap((project) => project.settings.keyPrefixes ?? []))]
    .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
}

/** A fresh bare-ticket matcher; constructing it is what lazily reads the register. */
export function keyPattern(): RegExp {
  const keys = keyPrefixes()
  return new RegExp(keys ? `\\b(?:${keys})-\\d+` : '(?!)', 'g')
}

/** The worktree directory's own name, whatever is nested below it. */
const WORKTREE_DIR = /\.claude\/worktrees\/([^/]+)/

/**
 * A key inside a worktree directory name.
 *
 * Deliberately loose about separator and case, because the naming convention
 * is not one convention. All of these are live in `orch.db` right now:
 *
 *     .claude/worktrees/AB-2533
 *     .claude/worktrees/STAR-5347
 *     .claude/worktrees/worktree-ADN-703-markdown-render
 *     .claude/worktrees/technical_sto_986_nexus_shell_barrel
 *
 * The last one is why this is not anchored to the start of the name: the key
 * sits in the middle, lowercased, with underscores. Anchoring — the obvious
 * first cut — would have silently dropped every attribution from the project whose worktrees carry underscores while
 * looking like it worked, because the other three shapes match fine.
 *
 * The prefix is guarded so `lab-2533` does not read as `AB-2533` — but with a
 * lookbehind rather than `\b`, because `_` IS a word character and `\b` finds
 * no boundary in `technical_sto_986`. That is the whole bug in one detail.
 */
function worktreeKeyPattern(): RegExp {
  const keys = keyPrefixes()
  return new RegExp(keys ? `(?<![A-Za-z0-9])(${keys})[-_](\\d+)` : '(?!)', 'i')
}

/** The ticket key a worktree path names, normalized, or null. */
export function keyFromWorktree(cwd: string): string | null {
  const dir = cwd.match(WORKTREE_DIR)?.[1]
  if (!dir) return null
  const m = dir.match(worktreeKeyPattern())
  if (!m) return null
  return `${m[1]!.toUpperCase()}-${m[2]}`
}

/**
 * Which project a working directory belongs to, or null for anything else.
 *
 * Read from a path rather than from a transcript's directory name: a session
 * started in ~/Projects carries a folder name that says nothing about what it
 * touched, and a single session can move between repos.
 *
 * The numbered-clone suffix is stripped because the other machine checks out
 * numbered clones such as `application-0` and `application-1`, and those are the same repo. Missing
 * that read 26B tokens of canon work as untracked — 65% of a window — because
 * most of the estate's transcripts come from numbered checkouts.
 */
export function projectOf(cwd: string | undefined | null): Project | null {
  if (!cwd) return null
  const path = resolve(cwd)
  const contained = projects()
    .filter(
      (project) => path === resolve(project.path) || path.startsWith(resolve(project.path) + '/'),
    )
    .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0]
  if (contained) return contained.name

  const root = projectRoot()
  if (!root || !path.startsWith(root + '/')) return null
  const clone = path
    .slice(root.length + 1)
    .split('/')[0]!
    .match(/^(.+)-\d+$/)?.[1]
  return projects().find((project) => project.name === clone)?.name ?? null
}

/** Whether a key has a prefix registered for the already-known project. */
function keyBelongsToProject(key: string, project: Project): boolean {
  const prefix = key.split('-')[0]!.toUpperCase()
  const registered = projects().find((candidate) => candidate.name === project)
  return (registered?.settings.keyPrefixes ?? [])
    .map((value) => value.toUpperCase())
    .includes(prefix)
}

export type Attribution = {
  project: Project | null
  key: string | null
  /** How the key was decided — recorded so a wrong one is diagnosable. */
  via:
    | 'launch_key'
    | 'worktree'
    | 'commit'
    | 'prompt'
    | 'branch'
    | 'prompt-file'
    | 'sibling-leg'
    | null
}

/**
 * Payloads that arrive in a transcript looking like something the user typed.
 *
 * A skill body, a system reminder, a pasted code-review pack or a
 * session-continuation summary can all quote a ticket key that the session was
 * never working on. Reading a key out of one of those hands an unrelated task
 * somebody else's hours, so text carrying these markers is not searched.
 *
 * Ported from work-report's `_INJECTED_MARKERS`, which learned the list the
 * hard way.
 */
const INJECTED = [
  '<system-reminder>',
  '<command-name>',
  '<local-command-stdout>',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous',
  'Analysis:\nLet me chronologically analyze',
  '<task-notification>',
]

export function isInjected(text: string): boolean {
  return INJECTED.some((m) => text.includes(m))
}

/**
 * Decide the task a span of work belongs to.
 *
 * Priority is deliberate and runs strongest-first: a worktree path is a
 * standing declaration by whoever created it, a commit subject is a claim made
 * at the moment of shipping, and prompt text is the weakest — a key mentioned
 * in passing is not the same as a key being worked on.
 *
 * Returning `{ key: null }` is a real answer, not a failure. That work is
 * reported against its project with no task, because the alternative — guessing
 * — is how one task ends up wearing another's cost.
 */
export function attribute(input: {
  cwd?: string | null
  commitSubjects?: string[]
  prompts?: string[]
}): Attribution {
  const project = projectOf(input.cwd)

  const fromWorktree = input.cwd ? keyFromWorktree(input.cwd) : null
  if (fromWorktree) {
    return { project, key: fromWorktree, via: 'worktree' }
  }

  for (const subject of input.commitSubjects ?? []) {
    const m = subject.match(keyPattern())
    if (m?.[0]) {
      const key = m[0].toUpperCase()
      return { project, key, via: 'commit' }
    }
  }

  for (const prompt of input.prompts ?? []) {
    if (isInjected(prompt)) continue
    const m = prompt.match(keyPattern())
    if (m?.[0]) {
      const key = m[0].toUpperCase()
      // A key from prose only counts when it belongs to the repo the work was
      // happening in. Cross-project chatter is common — a session in one project
      // discussing another project's ticket is not time spent on that ticket.
      if (project && !keyBelongsToProject(key, project)) continue
      return { project, key, via: 'prompt' }
    }
  }

  return { project, key: null, via: null }
}

/**
 * The task a delegated run's FULL prompt names, read from the file orch kept.
 *
 * `prompt_head` is the first 200 characters, and for the runs that matter it is
 * 200 characters of preamble. A review lens opens "You are a code reviewer in
 * the project's code-review workflow. FIRST: fetch your review..." and
 * names its ticket well after that, so the head never carries the key and the
 * run falls through to the commit window - which then guesses a DIFFERENT
 * ticket that happened to be committed in the same repo around the same time.
 * Runs 451-454 are four review lenses on STAR-5364 filed under STAR-5309 that
 * way, and across the estate the weak signal was doing 58 attributions to the
 * strong one's 17.
 *
 * Cached by path: a prompt file is written once and never rewritten, so this is
 * read at most once per run per process however often the dashboard redraws.
 */
const promptFileKey = new Map<string, string | null>()

/**
 * The ticket a branch name declares, if it declares one.
 *
 * Direct evidence of the same kind as a worktree path: somebody named the
 * branch before the work started. Reuses the worktree matcher because the
 * shapes are identical - `technical/STAR-5362-delete-...`, `AB-2533`,
 * `technical_sto_986_nexus_shell_barrel` - including the underscore case that
 * `\b` cannot handle.
 *
 * Partial by nature, and worth saying so: 53 of this estate's 60 branches carry
 * a key, but three main checkouts all sit on
 * `develop`, and a main-checkout run is exactly the one with nothing else
 * naming it. This helps where the checkout is on a ticket branch.
 */
export function keyFromBranch(
  branch: string | null | undefined,
  project: Project | null,
): string | null {
  if (!branch) return null
  const m = branch.match(worktreeKeyPattern())
  if (!m) return null
  const key = `${m[1]!.toUpperCase()}-${m[2]}`
  if (project && !keyBelongsToProject(key, project)) return null
  return key
}

function keyFromPromptFile(
  path: string | null | undefined,
  project: Project | null,
): string | null {
  if (!path) return null
  if (promptFileKey.has(path)) return promptFileKey.get(path) ?? null
  let key: string | null = null
  try {
    for (const m of readFileSync(path, 'utf8').matchAll(keyPattern())) {
      const k = m[0]!.toUpperCase()
      // The same ownership rule prose keys already follow: a run in one project
      // mentioning an AB ticket is chatter, not time spent on it.
      if (project && !keyBelongsToProject(k, project)) continue
      key = k
      break
    }
  } catch {
    /* the file may have been cleaned up; that is not an error */
  }
  promptFileKey.set(path, key)
  return key
}

/**
 * Decide the task for one delegated run, with orch's explicit launch key first.
 * Historical rows without one follow the existing direct-evidence cascade.
 * taskRecord reads this decision downstream through interval.task_key.
 */
export function attributeRun(run: OrchRun): Attribution {
  const launchKey =
    typeof run.launch_key === 'string' && run.launch_key.trim()
      ? run.launch_key.trim().toUpperCase()
      : null
  if (launchKey) {
    const project = projectOf(run.cwd)
    return {
      project,
      key: launchKey,
      via: 'launch_key',
    }
  }

  const result = attribute({ cwd: run.cwd, prompts: [run.prompt_head] })
  if (!result.key) {
    const branch = keyFromBranch(run.branch, result.project)
    if (branch) return { ...result, key: branch, via: 'branch' }
  }
  if (!result.key) {
    const promptFile = keyFromPromptFile(run.prompt_path, result.project)
    if (promptFile) return { ...result, key: promptFile, via: 'prompt-file' }
  }
  return result
}

/**
 * There is deliberately no commit-window attribution here any more.
 *
 * It asked "was something committed in this repo while this ran" and answered
 * with a task key. Measured on a holdout where the truth is known - legs in a
 * plain checkout whose own user prompt names the ticket, which is exactly the
 * population it existed to serve - it was right 7 times in 260. Three percent,
 * about what naming an open ticket at random would score, while carrying 102
 * hours and 8.4B tokens of this estate's history.
 *
 * On delegated RUNS it was worse: 0 of 13 against direct evidence, with four
 * wrong on topic - runs 294/297/304 are Nexus/Stride design-system work filed
 * under STO-980, "Extract the reprint dialog out of inventory.tsx" - and 22 of
 * its 38 attributions decided by a single nearby commit or a tie broken on
 * commit order.
 *
 * The replacement, in the transcripts ingest, is the nearest DIRECTLY
 * attributed leg of the same session: 39% on the same holdout, and 38% against
 * the window's 2% where both fire. Still weak, still recorded as its own `via`
 * so nobody mistakes it for evidence - but it asks about this session rather
 * than about the repo.
 *
 * `commit_key` is still collected and still used by `attribute()` above, where
 * a commit SUBJECT is a claim the session itself made. That is a different
 * thing from a commit merely landing nearby, and the difference is the whole
 * finding.
 */
