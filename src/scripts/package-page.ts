// Selection on the package page. Every answer, checks panel and version list is already in the
// HTML; this only moves the selection, toggles `hidden`, and mirrors the choice to ?rn=&line=.
import { announce } from './announce';

interface PickState {
  rn: string;
  line: string;
}

const page = document.querySelector<HTMLElement>('[data-package-page]');

if (page) {
  const pickers = [...page.querySelectorAll<HTMLButtonElement>('[data-pick-rn]:not([data-pick-line])')];
  const cells = [...page.querySelectorAll<HTMLButtonElement>('[data-pick-line]')];
  const answers = [...page.querySelectorAll<HTMLElement>('[data-answer]')];
  const panels = [...page.querySelectorAll<HTMLElement>('[data-checks]')];
  const lists = [...page.querySelectorAll<HTMLElement>('[data-list]')];
  const tableScroll = page.querySelector<HTMLElement>('[data-table-scroll]');
  const picker = page.querySelector<HTMLElement>('[data-picker]');

  // The picker buttons carry each version's default line: the best compatible one, else the newest.
  const defaultLine = new Map<string, string>();
  for (const button of page.querySelectorAll<HTMLButtonElement>('[data-picker] [data-pick-rn]')) {
    defaultLine.set(button.dataset.pickRn ?? '', button.dataset.defaultLine ?? '');
  }
  const lines = new Set(cells.map((cell) => cell.dataset.pickLine ?? ''));

  function render({ rn, line }: PickState): void {
    for (const button of pickers) {
      button.setAttribute('aria-pressed', String(button.dataset.pickRn === rn));
    }
    for (const cell of cells) {
      const inColumn = cell.dataset.pickRn === rn;
      cell.classList.toggle('in-col', inColumn);
      cell.setAttribute('aria-pressed', String(inColumn && cell.dataset.pickLine === line));
    }
    for (const answer of answers) answer.hidden = answer.dataset.answer !== rn;
    for (const panel of panels) panel.hidden = panel.dataset.checks !== `${line}@${rn}`;
    for (const list of lists) list.hidden = list.dataset.list !== rn;
  }

  function writeUrl({ rn, line }: PickState): void {
    const url = new URL(window.location.href);
    url.searchParams.set('rn', rn);
    url.searchParams.set('line', line);
    history.replaceState(history.state, '', url);
  }

  // The chosen cell's panel changes far down the page, so say what it now shows,
  // e.g. "2.1.x on React Native 0.87: Compatible".
  function announceSelection({ rn, line }: PickState): void {
    const panel = panels.find((p) => p.dataset.checks === `${line}@${rn}`);
    const title = panel?.querySelector('h2')?.textContent?.trim();
    const status = panel?.querySelector('[data-status]')?.textContent?.trim();
    if (title && status) announce(`${title}: ${status}`);
  }

  function select(selection: PickState): void {
    render(selection);
    writeUrl(selection);
    announceSelection(selection);
  }

  // Scrolls a sideways row so the element sits in the middle of what is visible, without ever
  // moving the page vertically (scrollIntoView would). `covered` is the width of a pinned column.
  function centreHorizontally(scroller: HTMLElement | null, target: Element | null | undefined, covered = 0): void {
    if (!scroller || !target || scroller.scrollWidth <= scroller.clientWidth) return;
    const scrollerBox = scroller.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    const targetLeft = targetBox.left - scrollerBox.left + scroller.scrollLeft;
    const visible = scroller.clientWidth - covered;
    scroller.scrollLeft = targetLeft - covered - (visible - targetBox.width) / 2;
  }

  function revealColumn(rn: string): void {
    const pinned = tableScroll?.querySelector('tbody th')?.getBoundingClientRect().width ?? 0;
    centreHorizontally(
      tableScroll,
      tableScroll?.querySelector(`thead [data-pick-rn="${CSS.escape(rn)}"]`),
      pinned,
    );
    centreHorizontally(picker, picker?.querySelector(`[data-pick-rn="${CSS.escape(rn)}"]`));
  }

  function initialSelection(): PickState {
    const params = new URLSearchParams(window.location.search);
    const pressed = pickers.find((button) => button.getAttribute('aria-pressed') === 'true');
    const fallbackRn = pressed?.dataset.pickRn ?? '';

    const askedRn = params.get('rn');
    const rn = askedRn && defaultLine.has(askedRn) ? askedRn : fallbackRn;
    const askedLine = params.get('line');
    const line = askedLine && lines.has(askedLine) ? askedLine : (defaultLine.get(rn) ?? '');
    return { rn, line };
  }

  page.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('[data-pick-rn]');
    const rn = button?.dataset.pickRn;
    if (!button || !rn) return;

    const cellLine = button.dataset.pickLine;
    if (cellLine) {
      select({ rn, line: cellLine });
    } else {
      select({ rn, line: defaultLine.get(rn) ?? '' });
      revealColumn(rn);
    }
  });

  // The table buttons are disabled in the HTML so they do nothing visible without JavaScript.
  for (const button of [...pickers, ...cells]) button.disabled = false;

  const initial = initialSelection();
  render(initial);
  revealColumn(initial.rn);

  // Replace parameters that were ignored (e.g. ?rn=9.99) with the selection actually shown.
  const params = new URLSearchParams(window.location.search);
  if (
    (params.has('rn') || params.has('line')) &&
    (params.get('rn') !== initial.rn || params.get('line') !== initial.line)
  ) {
    writeUrl(initial);
  }
}
