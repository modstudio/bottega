// concern: reference-publish
/** Publishes tracked generated command-reference pages through the document service. */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { REFERENCE_GENERATOR } from './doc-generator.ts'
import { getDoc, listDocs, removeDoc, setDoc } from './docs.ts'

export type ReferencePublishResult = {
  slug: string
  disposition: 'created' | 'updated' | 'unchanged' | 'removed'
}

function title(body: string, file: string): string {
  const heading = body.match(/^# (.+)$/m)?.[1]?.trim()
  if (!heading) throw new Error(`${file}: generated reference page has no level-one heading`)
  return heading
}

function pageSlug(file: string, indexFile: string): string {
  return file === indexFile ? 'cli' : `cli-${basename(file, '.md')}`
}

/**
 * The generator links pages by file name; the reader serves each page at its slug beside its
 * siblings, so every `./<page>.md` link target becomes that page's slug.
 */
export function slugLinkedBody(body: string, indexName: string): string {
  return body.replace(/\]\(\.\/([^/)#]+)\.md(#[^)]*)?\)/g, (_, name: string, anchor = '') => {
    const slug = `${name}.md` === indexName ? 'cli' : `cli-${name}`
    return `](${slug}${anchor})`
  })
}

function trackedReferenceFiles(root: string): string[] {
  const result = Bun.spawnSync(['git', ...nulPathListArgs(['ls-files', 'docs/reference/*.md'])], {
    cwd: root,
    env: scrubbedGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not read tracked reference pages: ${result.stderr.toString().trim()}`)
  }
  return splitNulPaths(result.stdout.toString())
}

function orderedReferenceFiles(files: string[], indexFile: string, indexBody: string): string[] {
  const byName = new Map(files.map((file) => [basename(file), file]))
  const groupFiles = [...indexBody.matchAll(/\]\(\.\/([^/)]+\.md)\)/g)].map((match) => match[1]!)
  const ordered = [
    indexFile,
    ...groupFiles.map((name) => {
      const file = byName.get(name)
      if (!file) throw new Error(`${indexFile}: linked reference page ${name} is not tracked`)
      return file
    }),
  ]
  if (new Set(ordered).size !== files.length) {
    throw new Error(`${indexFile}: every tracked group page must appear exactly once in the index`)
  }
  return ordered
}

export async function publishReferenceDocs(
  root: string,
  files = trackedReferenceFiles(root),
): Promise<ReferencePublishResult[]> {
  const indexFile = files.find((file) => basename(file) === 'index.md')
  if (!indexFile)
    throw new Error('docs/reference/index.md is not tracked; regenerate the reference')
  const currentIndex = getDoc('project', PLATFORM_SLUG, 'cli')
  if (!currentIndex) {
    throw new Error(
      `project/${PLATFORM_SLUG}/cli does not exist; restore the existing CLI article first`,
    )
  }
  const indexBody = readFileSync(join(root, indexFile), 'utf8')
  const ordered = orderedReferenceFiles(files, indexFile, indexBody)
  const results: ReferencePublishResult[] = []
  for (const [position, file] of ordered.entries()) {
    const body = slugLinkedBody(readFileSync(join(root, file), 'utf8'), basename(indexFile))
    const slug = pageSlug(file, indexFile)
    const parentSlug = file === indexFile ? currentIndex.parent_slug : 'cli'
    const pagePosition = file === indexFile ? currentIndex.position : position - 1
    const existing = getDoc('project', PLATFORM_SLUG, slug)
    if (
      existing &&
      existing.form === 'reference' &&
      existing.kind === 'article' &&
      existing.body === body &&
      existing.title === title(body, file) &&
      existing.parent_slug === parentSlug &&
      existing.position === pagePosition
    ) {
      results.push({ slug, disposition: 'unchanged' })
      continue
    }
    await setDoc({
      scope: 'project',
      subject: PLATFORM_SLUG,
      slug,
      title: title(body, file),
      body,
      delivery: currentIndex.delivery,
      audiences: currentIndex.audiences,
      parentSlug,
      position: pagePosition,
      kind: 'article',
      form: 'reference',
      reason: 'publish generated command reference',
      generator: REFERENCE_GENERATOR,
    })
    results.push({ slug, disposition: existing ? 'updated' : 'created' })
  }
  const expected = new Set(ordered.map((file) => pageSlug(file, indexFile)))
  const removed = listDocs({ scope: 'project', subject: PLATFORM_SLUG })
    .filter(
      (doc) => doc.form === 'reference' && doc.parent_slug === 'cli' && !expected.has(doc.slug),
    )
    .sort((left, right) => left.position - right.position)
  for (const doc of removed) {
    await removeDoc('project', PLATFORM_SLUG, doc.slug, {
      reason: 'remove stale generated command reference',
      generator: REFERENCE_GENERATOR,
    })
    results.push({ slug: doc.slug, disposition: 'removed' })
  }
  return results
}
