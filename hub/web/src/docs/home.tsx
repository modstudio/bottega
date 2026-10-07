import { type FormEvent, useState } from 'react'
import { Kbd } from '@/ui/kbd/kbd'
import { SearchDialog } from './search.tsx'
import { buildDocTree } from './tree.ts'
import type { DocsSearchMatch, DocsTreeItem } from './types.ts'

export const FEATURED_GUIDE_LIMIT = 9

export type DocsHomeModel = {
  featured: DocsTreeItem[]
  topics: Array<{ heading: DocsTreeItem | null; items: DocsTreeItem[] }>
}

export function docsHomeModel(items: readonly DocsTreeItem[]): DocsHomeModel {
  const roots = buildDocTree(items.filter((item) => item.audience === 'user'))
  const ordered = roots.flatMap(function visit(node): DocsTreeItem[] {
    return [node, ...node.children.flatMap(visit)]
  })
  const featured = ordered.filter((item) => item.featured).slice(0, FEATURED_GUIDE_LIMIT)
  const topics: DocsHomeModel['topics'] = roots
    .filter((root) => root.children.length)
    .map((root) => ({ heading: root, items: root.children }))
  const more = roots.filter((root) => !root.children.length)
  if (more.length) topics.push({ heading: null, items: more })
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
  const openSearch = (event: FormEvent) => {
    event.preventDefault()
    setSearchOpen(true)
  }
  return (
    <main className="site-page docs-home">
      <div className="wrap doc-hero">
        <span className="eyebrow">Documentation</span>
        <h1>How can we help?</h1>
        <p>Install Bottega, dispatch your first run, and connect the projects you already have.</p>
        <form className="docs-home-search" onSubmit={openSearch}>
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search titles and text"
            aria-label="Search titles and text"
          />
          <Kbd>/</Kbd>
        </form>
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
