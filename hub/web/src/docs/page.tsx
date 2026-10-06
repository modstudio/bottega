import { useQuery } from '@tanstack/react-query'
import { useMatch, useNavigate } from '@tanstack/react-router'
import { History, Pencil, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { isHostedMode } from '@/lib/hub-mode'
import { trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { CreateDocDialog } from './create-dialog.tsx'
import { chooserProject, projectSubjects, searchSubject } from './filters.ts'
import type { DocsAudience, DocsTreeItem } from './types.ts'
import { docsSource } from './types.ts'
import { useDocsDocument, useDocsSearch, useDocsTree } from './use-docs.ts'
import { DocsView } from './view.tsx'

export function DocsPage() {
  const hosted = isHostedMode()
  const navigate = useNavigate()
  const whoami = useQuery({
    ...trpc.record.whoami.queryOptions(),
    enabled: hosted,
    retry: false,
  })
  const signedIn = hosted ? Boolean(whoami.data?.user && 'email' in whoami.data.user) : true
  const source = docsSource(hosted, signedIn)
  const detail = useMatch({ from: '/docs/$scope/$subject/$slug', shouldThrow: false })
  const params = detail?.params
  const search = detail?.search
  const [audience, setAudience] = useState<DocsAudience>('user')
  const [project, setProject] = useState<string | 'all'>('all')
  const [emptyChooserSet, setEmptyChooserSet] = useState(false)
  const [creating, setCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const catalog = useDocsTree(source)
  const subjects = useMemo(() => projectSubjects(catalog.items), [catalog.items])
  const selected = useMemo(() => {
    if (!params) return null
    const subject = params.subject === '_' ? null : params.subject
    return (
      catalog.items.find((item) => (search?.id ? item.id === search.id : false)) ??
      catalog.items.find(
        (item) =>
          item.scope === params.scope && item.subject === subject && item.slug === params.slug,
      ) ??
      null
    )
  }, [catalog.items, params, search?.id])
  const selectedAudience = selected?.audience
  const selectedId = selected?.id
  const selectedProject = selected?.projectName
  useEffect(() => {
    if (selectedAudience) setAudience(selectedAudience)
  }, [selectedAudience])
  useEffect(() => {
    if (!selectedId) return
    setProject(selectedProject ?? 'all')
    setEmptyChooserSet(true)
  }, [selectedId, selectedProject])
  useEffect(() => {
    if (selectedId || emptyChooserSet || catalog.isPending) return
    setProject(chooserProject(null, subjects))
    setEmptyChooserSet(true)
  }, [selectedId, emptyChooserSet, catalog.isPending, subjects])
  const reading = useDocsDocument(source, selected)
  const results = useDocsSearch(
    source,
    searchQuery,
    audience,
    searchSubject(project, catalog.items),
  )

  function open(item: DocsTreeItem) {
    void navigate({
      to: '/docs/$scope/$subject/$slug',
      params: {
        scope: item.scope,
        subject: item.subject ?? '_',
        slug: item.slug,
      },
      search: source === 'local' ? {} : { id: item.id },
    })
  }

  return (
    <>
      <DocsView
        items={catalog.items}
        selectedId={selected?.id ?? null}
        audience={audience}
        onAudience={setAudience}
        project={project}
        onProject={setProject}
        signedIn={signedIn}
        showProjectChooser={signedIn}
        doc={reading.document}
        onSelect={open}
        onLeaveTree={() => void navigate({ to: '/docs' })}
        searchQuery={searchQuery}
        onSearchQuery={setSearchQuery}
        searchResults={results.items}
        framed={hosted && !signedIn}
        loading={catalog.isPending}
        error={catalog.error?.message ?? reading.error?.message ?? results.error?.message ?? null}
        createAction={
          source === 'local' ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New doc
            </Button>
          ) : null
        }
        localActions={
          source === 'local' && selected ? (
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: '/docs/$scope/$subject/$slug',
                    params: {
                      scope: selected.scope,
                      subject: selected.subject ?? '_',
                      slug: selected.slug,
                    },
                    search: { edit: true },
                  })
                }
              >
                <Pencil size={14} />
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: '/docs/$scope/$subject/$slug',
                    params: {
                      scope: selected.scope,
                      subject: selected.subject ?? '_',
                      slug: selected.slug,
                    },
                    search: { history: true },
                  })
                }
              >
                <History size={14} />
                History
              </Button>
            </div>
          ) : null
        }
      />
      {source === 'local' && creating ? <CreateDocDialog open onOpenChange={setCreating} /> : null}
    </>
  )
}
