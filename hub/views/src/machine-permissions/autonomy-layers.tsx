import { ErrorState } from '@bottega/hub-ui/error-state'
import { Select, type SelectOption } from '@bottega/hub-ui/listbox/select'
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

/** One setting the table shows as a column: the preset, rulings, ship-to or one stage. */
export type AutonomyColumn = { id: string; label: string }

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
  wins,
  edit,
}: {
  layer: AutonomyLayerView
  column: AutonomyColumn
  wins: boolean
  edit: AutonomyEdit
}) {
  const value = layer.values[column.id] ?? null
  const choice = layer.editable?.[column.id]
  const tone = { wins, set: value !== null }
  return (
    <TableCell>
      <div data-tone={wins ? 'success' : undefined} className={autonomyLayersStyles(tone).cell()}>
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

/**
 * Where each autonomy setting comes from. Layers are listed in the order they are consulted;
 * the first one that says something decides, and that cell is marked.
 */
export function AutonomyLayers({
  layers,
  columns,
  edit,
  heading,
}: {
  layers: readonly AutonomyLayerView[]
  columns: readonly AutonomyColumn[]
  edit: AutonomyEdit
  heading?: React.ReactNode
}) {
  const winner = Object.fromEntries(
    columns.map((column) => [
      column.id,
      layers.find((layer) => layer.values[column.id] != null)?.scope ?? null,
    ]),
  )
  return (
    <TableCard heading={heading}>
      {edit.error ? <ErrorState title="Could not change autonomy" message={edit.error} /> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Layer</TableHead>
            {columns.map((column) => (
              <TableHead key={column.id}>{column.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {layers.map((layer) => (
            <TableRow key={layer.scope}>
              <TableCell>
                <span className={autonomyLayersStyles().layer()}>{layer.label}</span>
                <span className={autonomyLayersStyles().hint()}>{layer.hint}</span>
              </TableCell>
              {columns.map((column) => (
                <Cell
                  key={column.id}
                  layer={layer}
                  column={column}
                  wins={winner[column.id] === layer.scope}
                  edit={edit}
                />
              ))}
            </TableRow>
          ))}
          <TableRow>
            <TableCell>
              <span className={autonomyLayersStyles().layer()}>In effect</span>
              <span className={autonomyLayersStyles().hint()}>What agents get now.</span>
            </TableCell>
            {columns.map((column) => {
              const scope = winner[column.id]
              const layer = layers.find((candidate) => candidate.scope === scope)
              return (
                <TableCell key={column.id}>
                  <span className={autonomyLayersStyles().effect()}>
                    {layer?.values[column.id] ?? '—'}
                  </span>
                  <span className={autonomyLayersStyles().hint()}>{layer?.label ?? ''}</span>
                </TableCell>
              )
            })}
          </TableRow>
        </TableBody>
      </Table>
    </TableCard>
  )
}
