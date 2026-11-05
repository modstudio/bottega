import { ErrorState } from '@bottega/hub-ui/error-state'
import { Select, type SelectOption } from '@bottega/hub-ui/listbox/select'
import { InfoTip } from '@bottega/hub-ui/popover/info-tip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@bottega/hub-ui/table'
import { TableCard } from '@bottega/hub-ui/table-card'
import { autonomyLayersStyles } from './autonomy-layers.styles.ts'

/** One setting the table shows as a row: the preset, rulings, ship-to or one stage. */
export type AutonomyColumn = { id: string; label: string; hint?: string }

/** What one layer says, by column id; `null` means it says nothing and the next layer decides. */
export type AutonomyLayerView = {
  scope: string
  label: string
  hint: string
  values: Record<string, string | null>
  /** The columns this layer can change here; other cells read only. */
  editable?: Record<string, AutonomyChoice>
}

/**
 * One editable cell. `selected` is what this layer itself chose, which can differ from its
 * value: a stage that follows the layer's preset has a value but no choice of its own.
 */
export type AutonomyChoice = {
  options: readonly SelectOption[]
  selected: string | null
  /** The option that clears this layer's choice; disabled when nothing here can clear it. */
  unset: { label: string; disabled?: boolean }
}

export type AutonomyEdit = {
  run(scope: string, column: string, value: string | null): void
  pending: boolean
  error: string | null
}

const NOT_SET = '__not_set__'

function Cell({
  layer,
  column,
  edit,
}: {
  layer: AutonomyLayerView
  column: AutonomyColumn
  edit: AutonomyEdit
}) {
  const value = layer.values[column.id] ?? null
  const choice = layer.editable?.[column.id]
  const tone = { set: value !== null }
  return (
    <TableCell>
      <div>
        {choice ? (
          <Select
            size="sm"
            className={autonomyLayersStyles().select()}
            label={`${layer.label}: ${column.label}`}
            value={choice.selected ?? NOT_SET}
            options={[
              { value: NOT_SET, label: choice.unset.label, disabled: choice.unset.disabled },
              ...choice.options,
            ]}
            onChange={(next) => edit.run(layer.scope, column.id, next === NOT_SET ? null : next)}
          />
        ) : (
          <span className={autonomyLayersStyles(tone).value()}>{value ?? '—'}</span>
        )}
      </div>
    </TableCell>
  )
}

/** A name with its explanation behind a tip, so the explanation never crowds the table. */
function Named({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className={autonomyLayersStyles().named()}>
      {label}
      {hint ? <InfoTip label={`About ${label}`}>{hint}</InfoTip> : null}
    </span>
  )
}

/**
 * Where each autonomy setting comes from: one row per setting, one column per layer in the
 * order layers are consulted. The first layer that says something decides, and that cell is
 * marked; the In effect column shows the result.
 */
export function AutonomyLayers({
  layers,
  columns,
  edit,
  heading,
  scope,
}: {
  layers: readonly AutonomyLayerView[]
  columns: readonly AutonomyColumn[]
  edit: AutonomyEdit
  heading?: React.ReactNode
  /** Toolbar controls that choose what the table shows, such as the project. */
  scope?: React.ReactNode
}) {
  const winner = Object.fromEntries(
    columns.map((column) => [
      column.id,
      layers.find((layer) => layer.values[column.id] != null)?.scope ?? null,
    ]),
  )
  return (
    <TableCard heading={heading} filters={scope}>
      {edit.error ? <ErrorState title="Could not change autonomy" message={edit.error} /> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Setting</TableHead>
            <TableHead>
              <Named
                label="In effect"
                hint="What agents get now. Agents consult the layers from left to right and use the first one that says something; that cell is marked."
              />
            </TableHead>
            {layers.map((layer) => (
              <TableHead key={layer.scope}>
                <Named label={layer.label} hint={layer.hint} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {columns.map((column) => {
            const decided = layers.find((layer) => layer.scope === winner[column.id])
            return (
              <TableRow key={column.id}>
                <TableCell>
                  <Named label={column.label} hint={column.hint} />
                </TableCell>
                <TableCell>
                  <span className={autonomyLayersStyles().effect()}>
                    {decided?.values[column.id] ?? '—'}
                  </span>
                  <span className={autonomyLayersStyles().hint()}>{decided?.label ?? ''}</span>
                </TableCell>
                {layers.map((layer) => (
                  <Cell key={layer.scope} layer={layer} column={column} edit={edit} />
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableCard>
  )
}
