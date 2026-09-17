/**
 * Paths canon names legitimately even though they are not tracked by the
 * repository whose canon is being checked. Each exemption is exact and named:
 * broad matching here would turn a missing file into a silent pass.
 */
export const CANON_REFERENCE_EXEMPTIONS: { path: string; reason: string }[] = [
  {
    path: '.claude/worktrees',
    reason: 'gitignored directory where each project creates its worktrees; canon must name it.',
  },
  {
    path: 'hub/web/dist',
    reason: 'build output of the hub web app; absent until built and never tracked.',
  },
  {
    path: 'progress.json',
    reason:
      "a worker's scratch task pointer written under its run scratch directory, never tracked.",
  },
  {
    path: 'scripts/worktree',
    reason:
      "another project's CLI, referenced as an example of how those projects invoke their own worktree tooling.",
  },
  {
    path: 'scripts/sync/main',
    reason:
      "another project's sync fabric, referenced in cross-project process and backport comparisons.",
  },
  {
    path: 'scripts/sync',
    reason: "another project's sync entry point, referenced in cross-project operating evidence.",
  },
  {
    path: 'scripts/sync/config.sh',
    reason:
      "another project's sync module, referenced to compare dependency-checking behaviour across projects.",
  },
  {
    path: 'scripts/new-instance.sh',
    reason:
      "another project's retired sibling-checkout script, referenced to forbid porting that external design.",
  },
  {
    path: '.githooks/post-checkout',
    reason:
      "another project's branch-switch hook, referenced as a cross-project backport candidate.",
  },
]

/** A source location suffix describes a path; it is not part of that path. */
export function canonReferencePath(reference: string): string {
  return reference.replace(/:\d+(?:-\d+)?$/, '')
}
