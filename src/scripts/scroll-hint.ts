// Tables that scroll sideways inside their card (see .scroll-frame in global.css). The frame fades
// whichever edge still has columns past it, and the scroller gets `is-scrolled` once it has moved
// so its pinned column can cover the gap beside it. A scroller with data-scroll-start="end" opens
// scrolled to its last column, the newest React Native version; if it only starts to overflow
// later (the window was narrowed), it goes there then, unless the reader has already moved it.
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

  let placed = scroller.dataset.scrollStart !== 'end';
  const placeAtEnd = (): void => {
    if (placed || scroller.scrollWidth <= scroller.clientWidth) return;
    placed = true;
    scroller.scrollLeft = scroller.scrollWidth;
  };

  scroller.addEventListener(
    'scroll',
    () => {
      // Any movement, ours or the reader's, means the start position is settled.
      if (scroller.scrollLeft > 0) placed = true;
      update();
    },
    { passive: true },
  );
  new ResizeObserver(() => {
    placeAtEnd();
    update();
  }).observe(scroller);
  placeAtEnd();
  update();
}

// Keep this file a module so its top-level names stay private to it.
export {};
