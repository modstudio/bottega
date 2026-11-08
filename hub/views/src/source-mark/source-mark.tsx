import { Database, RadioTower } from 'lucide-react'
import { sourceMarkStyles } from './source-mark.styles.ts'

export function SourceMark({
  source,
  project,
  protocol,
}: {
  source: string | null | undefined
  project?: string | null
  protocol?: string | null
}) {
  const title =
    source === 'local'
      ? 'hub'
      : `${project ?? 'external'} · ${protocol ?? 'tracker protocol unknown'}`
  const Icon = source === 'local' ? Database : RadioTower
  return (
    <span className={sourceMarkStyles().root()} title={title}>
      <Icon size={13} aria-hidden />
      <span className={sourceMarkStyles().label()}>{title}</span>
    </span>
  )
}
