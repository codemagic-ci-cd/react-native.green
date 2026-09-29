// Tables that scroll sideways inside their card (see .scroll-frame in global.css). The frame fades
// whichever edge still has columns past it, and the scroller gets `is-scrolled` once it has moved
// so its pinned column can cover the gap beside it. A scroller with data-scroll-start="end" opens
// scrolled to its last column, the newest React Native version.
for (const frame of document.querySelectorAll<HTMLElement>('[data-scroll-frame]')) {
  const scroller = frame.querySelector<HTMLElement>('[data-table-scroll]');
  if (!scroller) continue;

  const update = (): void => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    // A pixel of slack absorbs sub-pixel scroll positions at fractional zoom levels.
    frame.classList.toggle('can-scroll-left', scroller.scrollLeft > 1);
    frame.classList.toggle('can-scroll-right', scroller.scrollLeft < max - 1);
    scroller.classList.toggle('is-scrolled', scroller.scrollLeft > 0);
  };

  if (scroller.dataset.scrollStart === 'end') scroller.scrollLeft = scroller.scrollWidth;
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);
  update();
}

// Keep this file a module so its top-level names stay private to it.
export {};
