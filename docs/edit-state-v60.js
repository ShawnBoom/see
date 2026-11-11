export function hasEdits(edit) {
  if (!edit) return false;
  return Boolean(edit?.filter)
    || edit?.strength !== 100
    || edit?.brightness !== 0
    || edit?.color !== 0
    || edit?.grain !== 0;
}

export function visibleEditLabel(edit, showOriginal) {
  return showOriginal || !hasEdits(edit) ? "Original" : "Edited";
}
