const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Gradient bar across the top, tracking how far down the story you are. */
export function initProgressBar(): void {
  const fill = document.querySelector<HTMLElement>('#progress span');
  if (!fill) return;

  let ticking = false;
  const update = () => {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - doc.clientHeight;
    const ratio = scrollable > 0 ? doc.scrollTop / scrollable : 0;
    fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    ticking = false;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true }
  );
  update();
}

/**
 * Fade-and-rise each `[data-reveal]` as it enters. Elements added later (the
 * live grid, the finder result) are picked up by calling `observe()` again.
 */
export function initReveal(): (root?: ParentNode) => void {
  if (reducedMotion()) {
    const showAll = (root: ParentNode = document) =>
      root.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('in'));
    showAll();
    return showAll;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
  );

  const observe = (root: ParentNode = document) =>
    root.querySelectorAll('[data-reveal]').forEach((el) => observer.observe(el));

  observe();
  return observe;
}

/**
 * Count a number up when it first appears. Cosmetic only — the value is set
 * immediately as text too, so it is correct even if the animation never runs.
 */
export function countUp(el: HTMLElement, value: number): void {
  el.textContent = String(value);

  if (reducedMotion() || value === 0) return;

  const run = () => {
    const duration = 900;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(value * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        run();
      }
    },
    { threshold: 0.4 }
  );
  observer.observe(el);
}
