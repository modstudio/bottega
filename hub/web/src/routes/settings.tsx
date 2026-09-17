import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useWindowState } from '@/lib/window'
import { queryClient, type SettingsResponse, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { EmptyState } from '@/ui/empty-state/empty-state'
import { Input } from '@/ui/field/input'
import { FieldSection, Panel, SettingBlock } from '@/ui/form-layout/form-layout'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'

type SettingsData = SettingsResponse['data']
type Report = SettingsData['report']
type FormState = {
  enabled: boolean
  to: string
  subjectPrefix: string
  fromName: string
  fromAddress: string
  windowHours: string
  minMinutes: string
  testTo: string
  projects: string[]
}

function formFrom(report: Report): FormState {
  return {
    enabled: report.enabled,
    to: report.to.join(', '),
    subjectPrefix: report.subjectPrefix,
    fromName: report.fromName,
    fromAddress: report.fromAddress,
    windowHours: String(report.windowHours),
    minMinutes: String(report.minMinutes),
    testTo: report.testTo,
    projects: report.projects,
  }
}

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  const { hours } = useWindowState()
  const query = useQuery(trpc.settings.get.queryOptions({ hours }, { refetchInterval: 10_000 }))
  const payload = query.data
  const data = payload?.data
  const [form, setForm] = useState<FormState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [said, setSaid] = useState('')

  useEffect(() => {
    if (data && !dirty) setForm(formFrom(data.report))
  }, [data, dirty])

  const save = useMutation({
    ...trpc.settings.save.mutationOptions(),
    onSuccess: async (result) => {
      setForm(formFrom(result.report))
      setDirty(false)
      setSaid('saved')
      await queryClient.invalidateQueries()
    },
    onError: (error) => setSaid(`refused: ${error.message}`),
  })
  const sendTest = useMutation({
    ...trpc.settings.sendTest.mutationOptions(),
    onSuccess: (result) => setSaid(`test sent to ${result.to.join(', ')} (${result.items} tasks)`),
    onError: (error) => setSaid(`test failed: ${error.message}`),
  })
  const collect = useMutation({
    ...trpc.settings.collect.mutationOptions(),
    onSuccess: async () => {
      setSaid('collected')
      await queryClient.invalidateQueries()
    },
    onError: (error) => setSaid(`collect failed: ${error.message}`),
  })

  function change(patch: Partial<FormState>) {
    setForm((current) => (current ? { ...current, ...patch } : current))
    setDirty(true)
  }

  function submit() {
    if (!form) return
    setSaid('saving')
    save.mutate({
      enabled: form.enabled,
      to: form.to
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      subjectPrefix: form.subjectPrefix,
      fromName: form.fromName,
      fromAddress: form.fromAddress,
      windowHours: Number(form.windowHours) || 24,
      minMinutes: Number(form.minMinutes) || 0,
      testTo: form.testTo,
      projects: form.projects,
    })
  }

  function test() {
    setSaid('sending a test (the summary takes about a minute)')
    sendTest.mutate()
  }

  return (
    <section>
      <PageHeader
        title="Daily report"
        subtitle={
          data
            ? `Over the last ${data.report.windowHours}h: ${data.preview.items} tasks, ${data.preview.engaged} engaged`
            : 'Loading settings...'
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={collect.isPending}
            onClick={() => collect.mutate()}
          >
            {collect.isPending ? 'Collecting...' : 'Refresh data'}
          </Button>
        }
      />

      {query.error ? (
        <p data-tone="error" className="text-status-text">
          could not load: {query.error.message}
        </p>
      ) : null}
      {data && form ? (
        <>
          <Panel className="mb-6 max-w-[640px]">
            <div className="space-y-4">
              <FieldSection
                title="Schedule and delivery"
                description="What the daily report sends, and where it goes."
              >
                <label
                  htmlFor="report-enabled"
                  className="flex items-center gap-2 text-sm font-semibold"
                >
                  <Checkbox
                    id="report-enabled"
                    checked={form.enabled}
                    onChange={(event) => change({ enabled: event.target.checked })}
                  />
                  Send daily report
                  <span className="font-normal text-text-muted">
                    Off records why a send did not happen.
                  </span>
                </label>
                <div className="grid gap-4 md:grid-cols-2">
                  <SettingBlock
                    label="Recipients"
                    hint="Comma separated."
                    control={
                      <Input
                        value={form.to}
                        onChange={(event) => change({ to: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Subject prefix"
                    control={
                      <Input
                        value={form.subjectPrefix}
                        onChange={(event) => change({ subjectPrefix: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="From name"
                    control={
                      <Input
                        value={form.fromName}
                        onChange={(event) => change({ fromName: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="From address"
                    control={
                      <Input
                        value={form.fromAddress}
                        onChange={(event) => change({ fromAddress: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Window (hours)"
                    control={
                      <Input
                        value={form.windowHours}
                        onChange={(event) => change({ windowHours: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Floor (minutes engaged)"
                    hint="Work below this floor is not sent."
                    control={
                      <Input
                        value={form.minMinutes}
                        onChange={(event) => change({ minMinutes: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Test address"
                    hint="Tests go here without changing the recipient list."
                    control={
                      <Input
                        value={form.testTo}
                        onChange={(event) => change({ testTo: event.target.value })}
                      />
                    }
                  />
                </div>
                <div>
                  <div className="mb-2 text-sm text-text-muted">Projects in the email</div>
                  <div className="flex flex-wrap gap-4">
                    {data.allProjects.map((project) => (
                      <label
                        key={project}
                        htmlFor={`report-project-${project}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={`report-project-${project}`}
                          checked={form.projects.includes(project)}
                          onChange={(event) =>
                            change({
                              projects: event.target.checked
                                ? [...form.projects, project]
                                : form.projects.filter((name) => name !== project),
                            })
                          }
                        />
                        {project}
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-text-muted">
                    The dashboard always includes every registered project; the email is a subset,
                    which is the whole reason this is a setting.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" disabled={save.isPending} onClick={submit}>
                    Save changes
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={sendTest.isPending}
                    onClick={test}
                  >
                    Send a test
                  </Button>
                  <span className="text-sm text-text-muted">{said}</span>
                </div>
              </FieldSection>
            </div>
          </Panel>

          <div className="max-w-[640px]">
            <SectionTitle
              detail={`${data.report.smtpUser} via ${data.report.smtpHost}:${data.report.smtpPort}`}
            >
              Delivery
            </SectionTitle>
          </div>
          <Panel className="mb-6 max-w-[640px]">
            <div>
              <div className="text-sm">
                <Badge tone={data.secrets.smtpPassword.resolves ? 'success' : 'error'}>
                  {data.secrets.smtpPassword.resolves ? 'password resolves' : 'password missing'}
                </Badge>{' '}
                <span className="text-text-muted">from {data.secrets.smtpPassword.ref}</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm text-text-muted">
                No secret is stored in hub.db. This holds a reference; the password stays in the
                login keychain, and the page is only ever told whether it resolves.
              </p>
            </div>
          </Panel>

          <div className="max-w-[640px]">
            <SectionTitle>Recent sends</SectionTitle>
          </div>
          <div className="mb-6 max-w-[640px] border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead numeric>Items</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sends.length
                  ? data.sends.map((row) => (
                      <TableRow key={`${row.at}:${row.recipients}`}>
                        <TableCell muted>{row.at.slice(0, 16).replace('T', ' ')}</TableCell>
                        <TableCell>
                          <Badge tone={row.status === 'failed' ? 'error' : 'neutral'}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell numeric>{row.items.toLocaleString()}</TableCell>
                        <TableCell muted>
                          {row.test ? <Badge className="mr-2">test</Badge> : null}
                          {row.error || row.recipients}
                        </TableCell>
                      </TableRow>
                    ))
                  : null}
              </TableBody>
            </Table>
            {!data.sends.length ? (
              <EmptyState
                title="No reports have been sent."
                hint="Send a test or enable delivery to create a send record."
              />
            ) : null}
          </div>

          <div className="max-w-[640px]">
            <SectionTitle
              detail={
                data.register.length ? `${data.register.length} registered` : 'None registered'
              }
            >
              Projects
            </SectionTitle>
          </div>
          <Panel className="max-w-[640px]">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-text-muted">
                Read only. Hub cannot write the orchestrator register.
              </p>
              <Button size="sm" render={<Link to="/projects" />}>
                View projects
              </Button>
            </div>
          </Panel>
        </>
      ) : null}
    </section>
  )
}
