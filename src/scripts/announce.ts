// Speaks a short message through the page's polite live region (<p data-live>).
export function announce(message: string): void {
  const live = document.querySelector<HTMLElement>('[data-live]');
  if (!live) return;
  // Clearing first makes screen readers repeat a message that is the same as the last one.
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = message;
  }, 50);
}
