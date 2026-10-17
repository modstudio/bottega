import { Tabs } from '@bottega/hub-ui/tabs'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { detailRailStyles } from './detail-rail.styles.ts'
import { useHeldPanel } from './use-held-panel.ts'

export function DetailRail({
  label,
  tabs,
  defaultTab,
  onTabChange,
  top,
}: {
  label: string
  tabs: { value: string; label: string; content: ReactNode; hidden?: boolean }[]
  defaultTab: string
  onTabChange?: (value: string) => void
  top?: ReactNode
}) {
  const visible = tabs.filter((tab) => !tab.hidden)
  const [selected, setSelected] = useState(defaultTab)
  const active = visible.some((tab) => tab.value === selected) ? selected : visible[0]?.value
  useEffect(() => {
    if (active && active !== selected) {
      setSelected(active)
      onTabChange?.(active)
    }
  }, [active, selected, onTabChange])
  const panel = useRef<HTMLElement>(null)
  const tabsContainer = useRef<HTMLDivElement>(null)
  const tabPanel = useRef<HTMLDivElement>(null)
  useHeldPanel(panel)
  useEffect(() => {
    const controlled = tabsContainer.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute('aria-controls')
    if (controlled && tabPanel.current) tabPanel.current.id = controlled
  })
  const choose = (value: string) => {
    setSelected(value)
    onTabChange?.(value)
  }
  return (
    <aside ref={panel} className={detailRailStyles().aside()}>
      {top ? <div className={detailRailStyles().top()}>{top}</div> : null}
      <div ref={tabsContainer} className={detailRailStyles().tabs()}>
        <Tabs
          label={label}
          value={active ?? ''}
          onChange={choose}
          items={visible.map(({ value, label: tabLabel }) => ({ value, label: tabLabel }))}
        />
      </div>
      <div ref={tabPanel} role="tabpanel" className={detailRailStyles().panel()}>
        {visible.find((tab) => tab.value === active)?.content}
      </div>
    </aside>
  )
}
