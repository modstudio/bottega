/** Whether the draft differs from the document that was loaded into the editor. */
function isDocDraftDirty(
  loaded: { title: string; body: string },
  draft: { title: string; body: string },
): boolean {
  return loaded.title !== draft.title || loaded.body !== draft.body
}

/** Whether the title is present enough to save. */
function isDocDraftTitleValid(title: string): boolean {
  return title.trim().length > 0
}

/** Whether Save may open: the draft is dirty and the title is valid. */
export function isDocSaveEnabled(
  loaded: { title: string; body: string },
  draft: { title: string; body: string },
): boolean {
  return isDocDraftDirty(loaded, draft) && isDocDraftTitleValid(draft.title)
}

/** Whether leaving edit must ask before discarding. */
export function docLeaveNeedsConfirmation(
  loaded: { title: string; body: string },
  draft: { title: string; body: string },
): boolean {
  return isDocDraftDirty(loaded, draft)
}

/** Whether a save or delete reason is present enough to submit. */
export function isDocReasonReady(reason: string): boolean {
  return reason.trim().length > 0
}
