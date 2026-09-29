// Stroke icons from the prototype. `body` is trusted SVG markup, rendered with set:html.
export const ICONS = {
  check: { viewBox: 16, strokeWidth: 2.2, body: '<path d="M3 8.6l3.1 3.1L13 4.8"></path>' },
  cross: { viewBox: 16, strokeWidth: 2.2, body: '<path d="M4 4l8 8M12 4l-8 8"></path>' },
  dash: { viewBox: 16, strokeWidth: 2.2, body: '<path d="M4.5 8h7"></path>' },
  external: { viewBox: 14, strokeWidth: 1.8, body: '<path d="M5.5 3H3v8h8V8.5M8 3h3v3M11 3L6.5 7.5"></path>' },
  copy: {
    viewBox: 18,
    strokeWidth: 1.8,
    body: '<rect x="6" y="6" width="9" height="9" rx="2"></rect><path d="M12 6V4.5A1.5 1.5 0 0 0 10.5 3h-6A1.5 1.5 0 0 0 3 4.5v6A1.5 1.5 0 0 0 4.5 12H6"></path>',
  },
  search: { viewBox: 18, strokeWidth: 2, body: '<circle cx="8" cy="8" r="5.5"></circle><path d="M12.5 12.5L16 16"></path>' },
  menu: { viewBox: 22, strokeWidth: 2, body: '<path d="M4 7h14M4 11h14M4 15h14"></path>' },
  close: { viewBox: 22, strokeWidth: 2, body: '<path d="M6 6l10 10M16 6L6 16"></path>' },
  back: { viewBox: 14, strokeWidth: 2, body: '<path d="M8.5 3L4.5 7l4 4"></path>' },
  sun: {
    viewBox: 18,
    strokeWidth: 1.8,
    body: '<circle cx="9" cy="9" r="3.2"></circle><path d="M9 1.8v1.6M9 14.6v1.6M1.8 9h1.6M14.6 9h1.6M3.9 3.9l1.1 1.1M13 13l1.1 1.1M3.9 14.1L5 13M13 5l1.1-1.1"></path>',
  },
  moon: { viewBox: 18, strokeWidth: 1.8, body: '<path d="M15 10.6A6.3 6.3 0 1 1 7.4 3a5 5 0 0 0 7.6 7.6z"></path>' },
} as const;

export type IconName = keyof typeof ICONS;
