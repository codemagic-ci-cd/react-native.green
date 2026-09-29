// Below 768px the header links collapse behind the menu button.
const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
const menu = document.querySelector<HTMLElement>('[data-menu]');

function isOpen(): boolean {
  return toggle?.getAttribute('aria-expanded') === 'true';
}

function setOpen(open: boolean): void {
  toggle?.setAttribute('aria-expanded', String(open));
  toggle?.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  menu?.classList.toggle('is-open', open);
}

function insideMenu(node: EventTarget | null): boolean {
  return node instanceof Node && (menu?.contains(node) === true || toggle?.contains(node) === true);
}

toggle?.addEventListener('click', () => setOpen(!isOpen()));

// Following an in-page link such as /#how should not leave the menu covering the page.
menu?.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
});

document.addEventListener('click', (event) => {
  if (isOpen() && !insideMenu(event.target)) setOpen(false);
});

// Tabbing past the last link, or back before the button, closes the menu.
for (const element of [menu, toggle]) {
  element?.addEventListener('focusout', (event) => {
    if (isOpen() && event.relatedTarget !== null && !insideMenu(event.relatedTarget)) setOpen(false);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isOpen()) {
    setOpen(false);
    toggle?.focus();
  }
});

// Keep this file a module so its top-level names stay private to it.
export {};
