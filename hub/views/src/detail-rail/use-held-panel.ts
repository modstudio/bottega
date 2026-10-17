import { type RefObject, useEffect } from 'react'

/** Room a held panel has: from where it sticks down to the window's or its container's end. */
export function heldPanelHeight(stickTop: number, viewportHeight: number, containerBottom: number) {
  return Math.max(0, Math.min(viewportHeight, containerBottom) - stickTop)
}

/**
 * Keep a sticky side panel where it is while the page scrolls. A sticky element is pushed out
 * with its container's end, so as that end comes into view the panel is made shorter instead
 * and scrolls its own content. Does nothing where the panel is not sticky.
 */
export function useHeldPanel(panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = panel.current
    const container = node?.parentElement
    if (!node || !container) return
    let frame = 0
    const fit = () => {
      frame = 0
      const style = getComputedStyle(node)
      if (style.position !== 'sticky') {
        node.style.removeProperty('max-height')
        return
      }
      const stickTop = Number.parseFloat(style.top) || 0
      const room = heldPanelHeight(
        stickTop,
        window.innerHeight,
        container.getBoundingClientRect().bottom,
      )
      node.style.maxHeight = `${room}px`
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit)
    }
    fit()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      node.style.removeProperty('max-height')
    }
  }, [panel])
}
