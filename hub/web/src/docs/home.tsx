import { useEffect, useState } from 'react'
import { Kbd } from '@/ui/kbd/kbd'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { SearchDialog } from './search.tsx'
import { buildDocTree } from './tree.ts'
import type { DocsSearchMatch, DocsTreeItem } from './types.ts'

export const FEATURED_GUIDE_LIMIT = 9

/** A topic column lists this many of its documents; the rest sit behind its "all" link. */
export const TOPIC_LINK_LIMIT = 5

export type DocsHomeModel = {
  featured: DocsTreeItem[]
  topics: Array<{ heading: DocsTreeItem | null; items: DocsTreeItem[]; total: number }>
}

export function docsHomeModel(items: readonly DocsTreeItem[]): DocsHomeModel {
  const roots = buildDocTree(items.filter((item) => item.audience === 'user'))
  const ordered = roots.flatMap(function visit(node): DocsTreeItem[] {
    return [node, ...node.children.flatMap(visit)]
  })
  const featured = ordered.filter((item) => item.featured).slice(0, FEATURED_GUIDE_LIMIT)
  const topics: DocsHomeModel['topics'] = roots
    .filter((root) => root.children.length)
    .map((root) => ({
      heading: root,
      items: root.children.slice(0, TOPIC_LINK_LIMIT),
      total: root.children.length,
    }))
  const more = roots.filter((root) => !root.children.length)
  if (more.length)
    topics.push({ heading: null, items: more.slice(0, TOPIC_LINK_LIMIT), total: more.length })
  return { featured, topics }
}

export function DocsHome({
  items,
  results,
  query,
  onQuery,
  onSelect,
  loading,
  error,
}: {
  items: readonly DocsTreeItem[]
  results: readonly DocsSearchMatch[]
  query: string
  onQuery: (query: string) => void
  onSelect: (item: DocsTreeItem) => void
  loading: boolean
  error: string | null
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const model = docsHomeModel(items)
  useEffect(() => {
    const openFromShortcut = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', openFromShortcut)
    return () => window.removeEventListener('keydown', openFromShortcut)
  }, [])
  return (
    <main className="site-page docs-home">
      <div className="wrap doc-hero">
        <span className="eyebrow">Documentation</span>
        <h1>How can we help?</h1>
        <p>
          Install {PLATFORM_NAME}, dispatch your first run, and connect the projects you already
          have.
        </p>
        <button className="docs-home-search" type="button" onClick={() => setSearchOpen(true)}>
          <span>Search titles and text</span>
          <Kbd>/</Kbd>
        </button>
      </div>
      {!loading ? (
        <section className="docs-home-content">
          <div className="wrap">
            {error ? <p>{error}</p> : null}
            {!error && !items.length ? <p>No user docs here yet.</p> : null}
            {!error && model.featured.length ? (
              <>
                <span className="eyebrow docs-home-eyebrow">Featured guides</span>
                <div className="grid g3 hover">
                  {model.featured.map((item) => (
                    <button
                      className="cell"
                      type="button"
                      key={item.id}
                      onClick={() => onSelect(item)}
                    >
                      <h3>{item.title}</h3>
                      <p>{item.summary}</p>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {!error && model.topics.length ? (
              <div className="docs-home-topics">
                <span className="eyebrow docs-home-eyebrow">Browse by topic</span>
                <div className="topics">
                  {model.topics.map((topic) => (
                    <div key={topic.heading?.id ?? 'more'}>
                      <h4>
                        {topic.heading ? (
                          <button type="button" onClick={() => onSelect(topic.heading!)}>
                            {topic.heading.title}
                          </button>
                        ) : (
                          'More'
                        )}
                      </h4>
                      <ul>
                        {topic.items.map((item) => (
                          <li key={item.id}>
                            <button type="button" onClick={() => onSelect(item)}>
                              {item.title}
                            </button>
                          </li>
                        ))}
                        {topic.total > topic.items.length ? (
                          <li>
                            <button
                              className="topic-all"
                              type="button"
                              onClick={() => onSelect(topic.heading ?? topic.items[0]!)}
                            >
                              All {topic.total} →
                            </button>
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        query={query}
        onQueryChange={onQuery}
        results={results}
        tree={items}
        onChoose={onSelect}
        scopeLabel="Searching the User guide docs"
      />
    </main>
  )
}
