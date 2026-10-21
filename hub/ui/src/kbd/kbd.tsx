import { kbdStyles } from './kbd.styles.ts'

/** A key or shortcut the reader presses. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return <kbd className={kbdStyles({ class: className })}>{children}</kbd>
}
