import type { SyntheticEvent } from 'react'

/**
 * The close and backdrop handlers a modal `<dialog>` owns. React passes a nested dialog's close
 * up the component tree, and a pointer on the backdrop targets the dialog element itself, so
 * each counts only when the dialog is its own target.
 */
export function dialogDismiss(dismiss: () => void) {
  const own = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) dismiss()
  }
  return { onClose: own, onPointerDown: own }
}
