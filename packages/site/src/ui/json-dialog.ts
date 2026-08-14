import type { NostrEvent } from '../seam/shared';
import { escapeHtml } from './escape';

/**
 * A read-only look at exactly what the relay holds, formatted but unedited.
 * Uses the browser's own modal layer, so Esc and click-outside work for free.
 */
export function openJsonDialog(event: NostrEvent, caption = 'The event, exactly as the relay holds it'): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'json-dialog';
  dialog.innerHTML = `
    <div class="json-head">
      <p>${escapeHtml(caption)}</p>
      <button type="button" class="cmd-btn" data-close>Close</button>
    </div>
    <pre><code>${escapeHtml(JSON.stringify(event, null, 2))}</code></pre>`;

  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (clicked) => {
    if (clicked.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());

  document.body.append(dialog);
  dialog.showModal();
}
