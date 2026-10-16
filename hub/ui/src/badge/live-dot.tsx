import { liveDotStyles } from './live-dot.styles.ts'
/** A pulsing dot for work that is running right now. */
export function LiveDot() {
  return (
    <span data-tone="success" className={liveDotStyles().slot1()}>
      <span className={liveDotStyles().slot2()}>Running</span>
    </span>
  )
}
