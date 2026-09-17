import { Link } from '@tanstack/react-router'
import { ArrowUpRight, ChevronDown, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Badge, type Tone } from '@/ui/badge/badge'
import { Button, IconButton } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { Identifier } from '@/ui/identifier/identifier'
import { Kbd } from '@/ui/kbd/kbd'
import { Select } from '@/ui/listbox/select'
import { Menu } from '@/ui/menu/menu'
import { SectionTitle } from '@/ui/page-header/page-header'
import { Popover } from '@/ui/popover/popover'
import { Separator } from '@/ui/separator/separator'
import { Spinner } from '@/ui/spinner/spinner'
import { Switch } from '@/ui/switch/switch'
import { toast } from '@/ui/toast/toast'
import { Tooltip } from '@/ui/tooltip/tooltip'

const tones: Tone[] = ['neutral', 'success', 'warning', 'error', 'info', 'progress']

const surfaces = [
  ['surface-page', 'bg-surface-page'],
  ['surface-raised', 'bg-surface-raised'],
  ['surface-sunken', 'bg-surface-sunken'],
  ['control-hover', 'bg-control-hover'],
  ['control-selected', 'bg-control-selected'],
  ['accent-fill', 'bg-control-hover-fill'],
] as const

const texts = [
  ['text-primary', 'text-text-primary'],
  ['text-secondary', 'text-text-secondary'],
  ['text-muted', 'text-text-muted'],
  ['text-disabled', 'text-text-disabled'],
] as const

const typeScale = [
  'text-3xl',
  'text-2xl',
  'text-xl',
  'text-lg',
  'text-md',
  'text-base',
  'text-sm',
  'text-xs',
] as const

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-3 border-border-subtle border-b py-3 last:border-b-0 sm:grid-cols-[10rem_1fr]">
      <div className="text-sm text-text-muted">{label}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

const agents = [
  { value: 'codex', label: 'Codex' },
  { value: 'grok', label: 'Grok' },
  { value: 'local-acp', label: 'Local ACP', note: 'local' },
  { value: 'qwen-local', label: 'Qwen local', note: 'retired', disabled: true },
]

function OverlayCatalog() {
  const [agent, setAgent] = useState('codex')
  const [dialog, setDialog] = useState(false)
  return (
    <div className="border border-border-default px-4">
      <Row label="Select">
        <Select label="Agent" value={agent} options={agents} onChange={setAgent} />
        <Select
          label="Agent (small)"
          size="sm"
          value={agent}
          options={agents}
          onChange={setAgent}
        />
      </Row>
      <Row label="Menu">
        <Menu
          trigger={
            <Button>
              Actions
              <ChevronDown />
            </Button>
          }
          items={[
            { label: 'Rename', icon: Pencil, onSelect: () => toast.info('Rename chosen') },
            { label: 'Duplicate', icon: Copy, onSelect: () => toast.info('Duplicate chosen') },
            { label: 'Archive', disabled: true, onSelect: () => undefined },
            {
              label: 'Delete',
              icon: Trash2,
              danger: true,
              onSelect: () => toast.error('Delete chosen'),
            },
          ]}
        />
      </Row>
      <Row label="Popover, Tooltip">
        <Popover label="Run detail" trigger={<Button>Open popover</Button>}>
          <p className="m-0 text-text-secondary">
            Anchored to its trigger; closes on outside click or Escape.
          </p>
        </Popover>
        <Tooltip label="Copies the run id">
          <IconButton variant="secondary" label="Copy run id">
            <Copy />
          </IconButton>
        </Tooltip>
      </Row>
      <Row label="Dialog, Toast">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button onClick={() => toast.success('Task DEV-674 saved')}>Success toast</Button>
        <Button onClick={() => toast.error('Could not reach the tracker')}>Error toast</Button>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Archive this doc?"
          description="Archived docs leave every pack until restored."
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDialog(false)
                  toast.success('Doc archived')
                }}
              >
                Archive
              </Button>
            </>
          }
        />
      </Row>
    </div>
  )
}

/** The live catalog of the rebuilt tokens and ui/ components. */
export function DesignCatalog() {
  return (
    <>
      <SectionTitle detail="Meanings from styles/tokens.css; toggle the theme to compare">
        Colour
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {surfaces.map(([name, className]) => (
          <div key={name} className="border border-border-default">
            <div className={`h-14 ${className}`} />
            <div className="border-border-default border-t p-2 font-mono text-xs">{name}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tones.map((tone) => (
          <div
            key={tone}
            data-tone={tone}
            className="border border-status-border bg-status-surface"
          >
            <div className="h-10 bg-status-fill" />
            <div className="p-2">
              <div className="font-medium text-status-text">{tone}</div>
              <div className="font-mono text-text-muted text-xs">
                fill · text · surface · border
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-6">
        {texts.map(([name, className]) => (
          <span key={name} className={className}>
            {name}
          </span>
        ))}
      </div>

      <SectionTitle detail="Inter for the interface, IBM Plex Mono for identifiers and code">
        Type
      </SectionTitle>
      <div className="border border-border-default px-4">
        {typeScale.map((size) => (
          <Row key={size} label={size}>
            <span className={size}>Engaged time is the union of every agent's spans</span>
          </Row>
        ))}
        <Row label="font-mono">
          <span className="font-mono">orch do implement --cwd DEV-674 0123456789</span>
        </Row>
      </div>

      <SectionTitle detail="Rounded tags; a tone sets colour and icon, labels are Title Case">
        Badge
      </SectionTitle>
      <div className="border border-border-default px-4">
        <Row label="subtle">
          {tones.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </Row>
        <Row label="solid">
          {tones.map((tone) => (
            <Badge key={tone} tone={tone} emphasis="solid">
              {tone}
            </Badge>
          ))}
        </Row>
        <Row label="dot, identifier">
          <Badge tone="progress" dot>
            running
          </Badge>
          <Badge identifier>DEV-674</Badge>
          <Badge icon={false} tone="warning">
            no_icon
          </Badge>
        </Row>
        <Row label="Identifier">
          <Identifier>DEV-674</Identifier>
          <Identifier>9c5bb2d6</Identifier>
        </Row>
      </div>

      <SectionTitle detail="Square, as Midday; primary is ink">Button</SectionTitle>
      <div className="border border-border-default px-4">
        {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
          <Row key={variant} label={variant}>
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <Button key={size} variant={variant} size={size}>
                {variant === 'danger' ? <Trash2 /> : <Plus />}
                Size {size}
              </Button>
            ))}
            <Button variant={variant} disabled>
              Disabled
            </Button>
          </Row>
        ))}
        <Row label="IconButton">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <IconButton key={size} size={size} label={`Copy (${size})`}>
              <Copy />
            </IconButton>
          ))}
          <IconButton variant="secondary" label="Add">
            <Plus />
          </IconButton>
        </Row>
        <Row label="render as link">
          <Button render={<Link to="/runs" />}>
            Open runs
            <ArrowUpRight />
          </Button>
        </Row>
      </div>

      <SectionTitle detail="One control recipe for every text field">Fields</SectionTitle>
      <div className="border border-border-default px-4">
        <Row label="Input">
          <Input aria-label="Small input" size="sm" placeholder="Small" className="max-w-48" />
          <Input aria-label="Input" placeholder="Search runs" className="max-w-64" />
          <Input
            aria-label="Invalid input"
            aria-invalid
            defaultValue="Invalid"
            className="max-w-48"
          />
          <Input
            aria-label="Disabled input"
            disabled
            defaultValue="Disabled"
            className="max-w-48"
          />
        </Row>
        <Row label="Input title">
          <Input aria-label="Title" size="title" defaultValue="Hosted notes (S3b)" />
        </Row>
        <Row label="Textarea">
          <Textarea aria-label="Textarea" placeholder="Write a note" className="max-w-md" />
          <Textarea
            aria-label="Code"
            code
            defaultValue={'{\n"kind":"adanim"\n}'}
            className="max-w-md"
          />
        </Row>
      </div>

      <SectionTitle detail="Browser top layer and anchor positioning; keyboard per WAI-ARIA">
        Overlays
      </SectionTitle>
      <OverlayCatalog />

      <SectionTitle>Selection and state</SectionTitle>
      <div className="border border-border-default px-4">
        <Row label="Checkbox">
          <Checkbox aria-label="Unchecked" />
          <Checkbox aria-label="Checked" defaultChecked />
          <Checkbox aria-label="Mixed" indeterminate />
          <Checkbox aria-label="Disabled" disabled />
        </Row>
        <Row label="Switch">
          <Switch aria-label="Off" />
          <Switch aria-label="On" defaultChecked />
          <Switch aria-label="Disabled" disabled />
        </Row>
        <Row label="Spinner, Kbd">
          <Spinner label="Loading" />
          <span className="inline-flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Row>
        <Row label="Separator">
          <div className="flex h-6 w-full items-center gap-3">
            <span>Left</span>
            <Separator orientation="vertical" />
            <span>Right</span>
          </div>
          <Separator />
        </Row>
      </div>
    </>
  )
}
