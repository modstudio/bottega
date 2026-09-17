import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Collection } from '@/components/collection'
import { DesignCatalog } from '@/components/design-catalog'
import {
  EmptyState,
  LiveDot,
  PageHeader,
  ProjectMark,
  SectionTitle,
  SourceMark,
  StatRow,
  StatTile,
} from '@/components/design-system'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Companion } from '@/ui/companion/companion'
import { Input } from '@/ui/field/input'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from '@/ui/form-layout/form-layout'
import { Identifier } from '@/ui/identifier/identifier'
import { Select } from '@/ui/listbox/select'
import { Segmented } from '@/ui/segmented/segmented'
import { Sheet } from '@/ui/sheet/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'
import { Tabs } from '@/ui/tabs/tabs'

export const Route = createFileRoute('/design')({ component: DesignPage })

function DesignPage() {
  const [segment, setSegment] = useState('one')
  const [tab, setTab] = useState('one')
  const [sheet, setSheet] = useState<'hub' | 'mcp' | 'git' | null>(null)
  const [collectionSearch, setCollectionSearch] = useState('')
  const samples = [
    {
      id: 'hub' as const,
      key: 'DEV-260',
      name: 'Local task',
      source: 'local',
      project: 'workshop',
      protocol: null,
      status: 'active',
      refusals: [],
    },
    {
      id: 'mcp' as const,
      key: 'STAR-5364',
      name: 'Tracker task',
      source: 'mcp',
      project: 'starship',
      protocol: 'array-mcp',
      status: 'In Review → review',
      refusals: [
        [
          'Change status',
          'No adapter has proven a status write to this tracker; hub refuses to guess a payload.',
        ],
        [
          'Edit title',
          'No adapter has proven a title write to this tracker; hub refuses to guess a payload.',
        ],
      ],
    },
    {
      id: 'git' as const,
      key: 'BET-2533',
      name: 'Git-derived task',
      source: 'git',
      project: 'beta',
      protocol: null,
      status: 'unknown',
      refusals: [
        ['Change status', 'Derived from git history; there is no tracker to write to.'],
        ['Edit title', 'Derived from git history; there is no tracker to write to.'],
      ],
    },
  ].filter((row) =>
    `${row.key} ${row.name} ${row.source}`.toLowerCase().includes(collectionSearch.toLowerCase()),
  )
  const selectedSample = samples.find((row) => row.id === sheet)

  return (
    <section>
      <PageHeader title="Design" subtitle="Hub's inspectable token and component surface" />

      <DesignCatalog />

      <SectionTitle detail="Tabs switch panels of one record; a segmented control filters a list">
        Tabs and segmented
      </SectionTitle>
      <div className="flex flex-wrap items-center gap-4">
        <Tabs
          label="Sample sections"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'one', label: 'Overview' },
            { value: 'two', label: 'Runs', count: 12 },
          ]}
        />
        <Segmented
          label="Sample segmented control"
          value={segment}
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
          onChange={setSegment}
        />
      </div>

      <SectionTitle>Table</SectionTitle>
      <div className="border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Component</TableHead>
              <TableHead>State</TableHead>
              <TableHead numeric>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Table row</TableCell>
              <TableCell>
                <Badge tone="success">ready</Badge>
              </TableCell>
              <TableCell numeric>1,024</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Quiet row</TableCell>
              <TableCell>
                <Badge>resting</Badge>
              </TableCell>
              <TableCell numeric>64</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <SectionTitle detail="Hub records open settings in a Sheet; tracker and git records open read-only in a Companion">
        Records: table card, Companion and Sheet
      </SectionTitle>
      <Collection
        title="Sample records"
        count={samples.length}
        search={{ query: collectionSearch, onQueryChange: setCollectionSearch }}
        columns={[
          { id: 'key', label: 'Key', render: (row) => <Identifier>{row.key}</Identifier> },
          { id: 'name', label: 'Record', render: (row) => row.name },
          {
            id: 'source',
            label: 'Source',
            render: (row) => (
              <SourceMark source={row.source} project={row.project} protocol={row.protocol} />
            ),
          },
          { id: 'status', label: 'Status', render: (row) => row.status },
        ]}
        rows={samples}
        getKey={(row) => row.id}
        onOpen={(row) => setSheet(row.id)}
        selectedKey={selectedSample?.id}
        panel={
          selectedSample && selectedSample.id !== 'hub' ? (
            <Companion
              title={<Identifier>{selectedSample.key}</Identifier>}
              subtitle={selectedSample.name}
              onClose={() => setSheet(null)}
            >
              <DisplayRow label="Status" value={selectedSample.status} />
              {selectedSample.refusals.map(([label, reason]) => (
                <DisplayRow key={label} label={label} value={reason} />
              ))}
            </Companion>
          ) : undefined
        }
        empty={{ title: 'No sample records match.' }}
      />
      <Sheet
        open={selectedSample?.id === 'hub'}
        onClose={() => setSheet(null)}
        footer={
          <>
            <Button onClick={() => setSheet(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => setSheet(null)}>
              Save
            </Button>
          </>
        }
        title={selectedSample?.key ?? 'Sample record'}
        subtitle={selectedSample?.name}
      >
        {selectedSample ? (
          <div className="space-y-4">
            <DisplayRow
              label="Source"
              value={
                <span className="inline-flex items-center gap-2">
                  <SourceMark
                    source={selectedSample.source}
                    project={selectedSample.project}
                    protocol={selectedSample.protocol}
                  />
                  {selectedSample.source === 'local'
                    ? 'hub'
                    : selectedSample.source === 'git'
                      ? 'git'
                      : `${selectedSample.project} · ${selectedSample.protocol}`}
                </span>
              }
            />
            {selectedSample.id === 'hub' ? (
              <>
                <SettingBlock
                  label="Task title"
                  control={<Input defaultValue={selectedSample.name} />}
                />
                <SettingBlock
                  label="Task status"
                  control={
                    <Select
                      label="Sample task status"
                      value={selectedSample.status}
                      options={['open', 'active', 'review', 'done', 'dropped'].map((status) => ({
                        value: status,
                        label: status,
                      }))}
                      onChange={() => {}}
                    />
                  }
                />
              </>
            ) : (
              <>
                <DisplayRow label="Status" value={selectedSample.status} />
                {selectedSample.refusals.map(([label, reason]) => (
                  <DisplayRow key={label} label={label} value={reason} />
                ))}
              </>
            )}
          </div>
        ) : null}
      </Sheet>

      <SectionTitle>Settings and detail grammar</SectionTitle>
      <div className="max-w-2xl border border-border-default p-4">
        <FieldSection title="Sample settings" description="A titled group for related controls.">
          <SettingBlock
            label="Example setting"
            control={<Input defaultValue="A controlled value" />}
            hint="A concise consequence or explanation."
            cli="orch example --value controlled"
          />
          <DisplayRow label="Read-only fact" value="Displayed without implying it can be changed" />
          <Copyable value="/a/path/or/command/to-copy" />
        </FieldSection>
      </div>

      <SectionTitle>Dashboard primitives</SectionTitle>
      <StatRow>
        <StatTile figure="42" label="Stat tile" hint="Supporting metadata" />
        <StatTile figure="7" label="Live work" hint="Pulsing state" live />
        <StatTile figure="99%" label="Ratio" />
      </StatRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <EmptyState title="Nothing here yet." hint="Empty states explain what belongs here." />
        <div className="flex items-center gap-5 border border-border-default p-4">
          <span data-tone="success" className="inline-flex items-center gap-2 text-status-text">
            <LiveDot />
            LiveDot
          </span>
          <ProjectMark name="sample" colors={{ sample: { light: '#6b2145', dark: '#ff8fb8' } }} />
        </div>
      </div>
    </section>
  )
}
