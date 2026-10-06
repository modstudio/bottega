import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Kbd } from '@/ui/kbd/kbd'
import { moveIndex } from '@/ui/state/list-navigation'
import { classes } from '@/ui/text/classes'
import { highlightSnippet } from './map.ts'
import type { DocsSearchMatch, DocsTreeItem } from './types.ts'

export function SearchDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  results,
  tree,
  onChoose,
  scopeLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  results: readonly DocsSearchMatch[]
  tree: readonly DocsTreeItem[]
  onChoose: (item: DocsTreeItem) => void
  scopeLabel: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [active, setActive] = useState(0)
  const byId = new Map(tree.map((item) => [item.id, item]))
  const bySlug = new Map(tree.map((item) => [item.slug, item]))

  useEffect(() => {
    if (!open) return
    setActive(0)
    input.current?.focus()
  }, [open])

  const choose = (match: DocsSearchMatch) => {
    const item = byId.get(match.id) ?? bySlug.get(match.slug)
    if (!item) return
    onChoose(item)
    onOpenChange(false)
  }

  const onListKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      return
    }
    if (!results.length) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const match = results[active]
      if (match) choose(match)
      return
    }
    const next = moveIndex(
      event.key,
      active,
      results.map(() => false),
    )
    if (next !== active) {
      event.preventDefault()
      setActive(next)
    }
  }

  const needle = query.trim()
  const hint =
    needle.length < 2
      ? 'Type at least two letters. Try "worktree" or "score".'
      : `Nothing matches "${needle}".`

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search docs"
      variant="chromeless"
      size="lg"
      className="top-[12vh] max-h-[min(35rem,80vh)]"
    >
      <div className="flex items-center gap-2.5 border-border-default border-b px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <Input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => {
              setActive(0)
              onQueryChange(event.target.value)
            }}
            onKeyDown={onListKey}
            placeholder="Search titles and text"
            aria-label="Search titles and text"
            aria-controls={listId}
            autoComplete="off"
          />
        </div>
        <Kbd>Esc</Kbd>
      </div>
      <div className="max-h-[min(25rem,56vh)] overflow-auto px-1.5 py-2">
        {results.length === 0 ? (
          <p className="mx-2.5 my-3.5 text-md text-text-muted">{hint}</p>
        ) : (
          <div id={listId} role="listbox">
            {results.map((match, index) => {
              const parts = highlightSnippet(match.snippet, match.matchPosition, needle)
              const selected = index === active
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the search input; arrow keys move aria-selected
                <div
                  key={`${match.id}:${match.slug}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerUp={() => choose(match)}
                  className={classes(
                    'cursor-pointer rounded-sm px-2.5 py-2',
                    selected && 'bg-control-hover',
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-md text-text-primary">{match.title}</span>
                    {match.spaceName ? (
                      <span className="text-text-muted text-xs">{match.spaceName}</span>
                    ) : null}
                  </div>
                  {match.snippet ? (
                    <p className="mt-0.5 text-sm text-text-muted leading-5">
                      {parts.before}
                      {parts.match ? (
                        <mark className="bg-surface-sunken text-text-primary">{parts.match}</mark>
                      ) : null}
                      {parts.after}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 border-border-default border-t px-3.5 py-2 text-text-muted text-xs">
        <span>
          <Kbd>↑</Kbd>
          <Kbd className="ml-1">↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span className="ml-auto">{scopeLabel}</span>
      </div>
    </Dialog>
  )
}
