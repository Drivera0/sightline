/** True when a key press is going into a text field, so keyboard shortcuts should stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.isContentEditable || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}
