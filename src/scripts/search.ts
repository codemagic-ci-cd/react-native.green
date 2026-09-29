// Filters the home table by package name as you type. Without JavaScript the full list shows.
const form = document.querySelector<HTMLFormElement>('[data-search]');
const input = form?.querySelector<HTMLInputElement>('input[type="search"]');
const rows = [...document.querySelectorAll<HTMLElement>('[data-package-row]')];
const empty = document.querySelector<HTMLElement>('[data-search-empty]');

function filter(query: string): void {
  const needle = query.trim().toLowerCase();
  let shown = 0;
  for (const row of rows) {
    const match = (row.dataset.name ?? '').includes(needle);
    row.hidden = !match;
    if (match) shown += 1;
  }
  if (empty) empty.hidden = shown > 0;
}

if (form && input) {
  input.addEventListener('input', () => filter(input.value));

  // Submitting only needs to bring the results into view; the list is already filtered.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    filter(input.value);
    document.getElementById('packages')?.scrollIntoView({ block: 'start' });
  });

  // A search submitted before the script loaded arrives as ?q=.
  const initial = new URLSearchParams(window.location.search).get('q');
  if (initial) input.value = initial;
  filter(input.value);
}

// Keep this file a module so its top-level names stay private to it.
export {};
