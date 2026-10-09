import { useEffect, useState } from 'react'
import { Badge } from '@/ui/badge/badge'
import { Kbd } from '@/ui/kbd/kbd'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { SearchDialog } from './search.tsx'
import { buildDocTree } from './tree.ts'
import type { DocsSearchMatch, DocsTreeItem } from './types.ts'

export const FEATURED_GUIDE_LIMIT = 9

export type DocsHomeModel = {
  featured: DocsTreeItem[]
  /** Top-level documents in tree order, each with how many documents sit beneath it. */
  topics: Array<{ doc: DocsTreeItem; count: number }>
}

export function docsHomeModel(items: readonly DocsTreeItem[]): DocsHomeModel {
  const roots = buildDocTree(items.filter((item) => item.audiences.includes('customer')))
  const ordered = roots.flatMap(function visit(node): DocsTreeItem[] {
    return [node, ...node.children.flatMap(visit)]
  })
  const featured = ordered.filter((item) => item.featured).slice(0, FEATURED_GUIDE_LIMIT)
  const topics = roots.map((root) => ({
    doc: root as DocsTreeItem,
    count: root.children.flatMap(function visit(node): DocsTreeItem[] {
      return [node, ...node.children.flatMap(visit)]
    }).length,
  }))
  return { featured, topics }
}

export function DocsHome({
  sourceLabel,
  items,
  results,
  query,
  onQuery,
  onSelect,
  loading,
  error,
}: {
  sourceLabel: string
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
        <div className="flex items-center gap-2">
          <span className="eyebrow">Documentation</span>
          <Badge icon={false}>{sourceLabel}</Badge>
        </div>
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
                    <button type="button" key={topic.doc.id} onClick={() => onSelect(topic.doc)}>
                      <span>{topic.doc.title}</span>
                      {topic.count ? <span className="topic-count">{topic.count}</span> : null}
                    </button>
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
