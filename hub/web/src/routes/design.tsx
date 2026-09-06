import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/dialog'
import {
  EmptyState, LiveDot, PageHeader, ProjectMark, SectionTitle, Segmented, StatRow, StatTile,
} from '@/components/design-system'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/tabs'
import { Textarea } from '@/components/textarea'
import { Collection } from '@/components/collection'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from '@/components/fields'
import { Sheet } from '@/components/sheet'

const semanticColors = [
  { name: 'success', light: '#1a7f4b', dark: '#4cc98a' },
  { name: 'warning', light: '#8a6317', dark: '#d9a441' },
  { name: 'info', light: '#2b3552', dark: '#2b3552' },
  { name: 'live', light: '#1a7f4b', dark: '#4cc98a' },
  { name: 'danger', light: '#9a3412', dark: '#e88a63' },
] as const

const badgeVariants = ['default', 'secondary', 'destructive', 'outline', 'success', 'warning', 'info', 'live', 'danger'] as const

export const Route = createFileRoute('/design')({ component: DesignPage })

function DesignPage() {
  const [select, setSelect] = useState('one')
  const [segment, setSegment] = useState('one')
  const [tab, setTab] = useState('one')
  const [dialog, setDialog] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [collectionSearch, setCollectionSearch] = useState('')
  const samples = [{ id: 1, name: 'Inspectable record', state: 'ready' }, { id: 2, name: 'Another record', state: 'resting' }]
    .filter((row) => row.name.toLowerCase().includes(collectionSearch.toLowerCase()))

  return <section>
    <PageHeader title="Design" subtitle="Hub's inspectable token and component surface" />

    <SectionTitle detail="Hub-owned meanings derived from the token scales">Semantic colour</SectionTitle>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {semanticColors.map((color) => <div key={color.name} className="border border-border">
        <div className="grid h-16 grid-cols-2">
          <div style={{ background: color.light }} aria-label={`${color.name} light`} />
          <div style={{ background: color.dark }} aria-label={`${color.name} dark`} />
        </div>
        <div className="p-2">
          <div className="font-semibold">--{color.name}</div>
          <div className="meta">light {color.light}</div>
          <div className="meta">dark {color.dark}</div>
        </div>
      </div>)}
    </div>

    <SectionTitle>Typography</SectionTitle>
    <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
      {[
        ['--font-ui', 'Interface text, figures 0123456789'],
        ['--font-heading', 'Headings carry the same terminal voice'],
        ['--font-prose', 'Long-form markdown remains comfortable to read.'],
        ['--font-mono', 'code --flag=value 0123456789'],
      ].map(([role, sample]) => <div key={role} className="bg-background p-4" style={{ fontFamily: `var(${role})` }}>
        <div className="meta mb-2">{role}</div><div className={role === '--font-heading' ? 'text-lg font-semibold tracking-tight' : ''}>{sample}</div>
      </div>)}
    </div>

    <SectionTitle>Button</SectionTitle>
    <div className="flex flex-wrap gap-2">
      <Button>Default</Button><Button variant="destructive">Destructive</Button><Button variant="outline">Outline</Button><Button variant="ghost">Ghost</Button>
      <Button size="sm">Small</Button><Button size="icon" aria-label="Icon button">+</Button><Button disabled>Disabled</Button>
    </div>

    <SectionTitle>Badge</SectionTitle>
    <div className="flex flex-wrap gap-2">{badgeVariants.map((variant) => <Badge key={variant} variant={variant}>{variant}</Badge>)}</div>

    <SectionTitle>Fields</SectionTitle>
    <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
      <Input aria-label="Sample input" defaultValue="Input" />
      <Select label="Sample select" value={select} options={[{ value: 'one', label: 'First option' }, { value: 'two', label: 'Second option', note: 'noted' }]} onChange={setSelect} />
      <Textarea aria-label="Sample textarea" defaultValue="Textarea" />
      <label className="flex items-center gap-2"><Checkbox defaultChecked /> Checkbox</label>
    </div>

    <SectionTitle>Selection</SectionTitle>
    <div className="flex flex-wrap items-center gap-4">
      <Tabs value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="one">First tab</TabsTrigger><TabsTrigger value="two">Second tab</TabsTrigger></TabsList></Tabs>
      <Segmented label="Sample segmented control" value={segment} options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} onChange={setSegment} />
    </div>

    <SectionTitle>Dialog</SectionTitle>
    <Button variant="outline" onClick={() => setDialog(true)}>Open dialog</Button>
    <Dialog open={dialog} onOpenChange={setDialog}>
      <DialogContent><DialogHeader><DialogTitle>Dialog title</DialogTitle><DialogDescription>A native dialog rendered through Hub's existing primitive.</DialogDescription></DialogHeader><Button onClick={() => setDialog(false)}>Close</Button></DialogContent>
    </Dialog>

    <SectionTitle>Table</SectionTitle>
    <div className="border border-border"><Table><TableHeader><TableRow><TableHead>Component</TableHead><TableHead>State</TableHead><TableHead className="num">Value</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>Table row</TableCell><TableCell><Badge variant="success">ready</Badge></TableCell><TableCell className="num">1,024</TableCell></TableRow><TableRow><TableCell>Quiet row</TableCell><TableCell><Badge variant="outline">resting</Badge></TableCell><TableCell className="num">64</TableCell></TableRow></TableBody></Table></div>

    <SectionTitle>Collection and Sheet</SectionTitle>
    <Collection title="Sample records" count={samples.length} search={{ query: collectionSearch, onQueryChange: setCollectionSearch }} columns={[{ id: 'name', label: 'Record', render: (row) => <strong>{row.name}</strong> }, { id: 'state', label: 'State', render: (row) => <Badge variant="outline">{row.state}</Badge> }]} rows={samples} getKey={(row) => row.id} onOpen={() => setSheet(true)} empty="No sample records match." />
    <Button className="mt-3" variant="outline" onClick={() => setSheet(true)}>Open sample Sheet</Button>
    <Sheet open={sheet} onClose={() => setSheet(false)} title="Inspectable record" subtitle="The collection remains visible and interactive">
      <DisplayRow label="State" value="ready" />
      <DisplayRow label="Identifier" value={<Copyable value="DEV-259" />} />
    </Sheet>

    <SectionTitle>Settings and detail grammar</SectionTitle>
    <div className="max-w-2xl border border-border p-4"><FieldSection title="Sample settings" description="A titled group for related controls."><SettingBlock label="Example setting" control={<Input defaultValue="A controlled value" />} hint="A concise consequence or explanation." cli="orch example --value controlled" /><DisplayRow label="Read-only fact" value="Displayed without implying it can be changed" /><Copyable value="/a/path/or/command/to-copy" /></FieldSection></div>

    <SectionTitle>Dashboard primitives</SectionTitle>
    <StatRow><StatTile figure="42" label="Stat tile" hint="Supporting metadata" /><StatTile figure="7" label="Live work" hint="Pulsing state" live /><StatTile figure="99%" label="Ratio" /></StatRow>
    <div className="grid gap-4 sm:grid-cols-2">
      <EmptyState title="Nothing here yet." hint="Empty states explain what belongs here." />
      <div className="flex items-center gap-5 border border-border p-4">
        <span className="inline-flex items-center gap-2 text-live"><LiveDot />LiveDot</span>
        <ProjectMark name="sample" colors={{ sample: { light: '#6b2145', dark: '#ff8fb8' } }} />
      </div>
    </div>
  </section>
}
