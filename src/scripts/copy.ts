// Copy buttons: <button data-copy="text"> inside a [data-copy-scope] that also holds the same text
// in a [data-copy-text] element. A button with data-copy-label shows "Copied" or "Copy failed" in
// place of its label; an icon button gets `is-copied` or `is-failed` so its styles can swap the icon.
//
// navigator.clipboard only exists on secure origins (not on a LAN address during development, for
// example). When it is missing or refuses, the text is selected so it can be copied by hand.
import { announce } from './announce';

const resetTimers = new WeakMap<HTMLButtonElement, number>();

function selectText(button: HTMLButtonElement): void {
  const source = button.closest('[data-copy-scope]')?.querySelector('[data-copy-text]');
  const selection = window.getSelection();
  if (!source || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges();
  selection.addRange(range);
}

function showResult(button: HTMLButtonElement, copied: boolean): void {
  const label = button.dataset.copyLabel;
  if (label) button.textContent = copied ? 'Copied' : 'Copy failed';
  button.classList.toggle('is-copied', copied);
  button.classList.toggle('is-failed', !copied);
  announce(copied ? 'Copied to clipboard' : 'Could not copy. The text is selected, so copy it with your keyboard.');

  window.clearTimeout(resetTimers.get(button));
  resetTimers.set(
    button,
    window.setTimeout(() => {
      if (label) button.textContent = label;
      button.classList.remove('is-copied', 'is-failed');
    }, 2000),
  );
}

document.addEventListener('click', async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>('[data-copy]');
  const text = button?.dataset.copy;
  if (!button || text === undefined) return;

  try {
    if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    showResult(button, true);
  } catch {
    selectText(button);
    showResult(button, false);
  }
});
