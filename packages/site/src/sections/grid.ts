import type { Channel, ChannelProfile } from '../nostr/queries';

/**
 * The currently-live channels, as cards.
 *
 * Each card links to the streamer's own server, not to a player Livelier hosts —
 * which is the whole promise of the bridge restated as a hyperlink: discovery
 * happens on the network, viewing happens on your machine.
 */
export function renderLiveGrid(
  container: HTMLElement,
  channels: Channel[],
  profiles: Map<string, ChannelProfile>
): void {
  if (channels.length === 0) {
    container.innerHTML =
      '<p class="grid-empty">Nobody is live on the bridge this minute. It happens — try again in a bit.</p>';
    return;
  }

  container.replaceChildren(...channels.map((channel) => card(channel, profiles)));
}

function card(channel: Channel, profiles: Map<string, ChannelProfile>): HTMLElement {
  const profile = channel.hostPubkey ? profiles.get(channel.hostPubkey) : undefined;
  const href = channel.proxyUrl ?? profile?.website ?? '#';

  const el = document.createElement('a');
  el.className = 'card';
  el.href = href;
  el.target = '_blank';
  el.rel = 'noopener';
  el.setAttribute('data-reveal', '');

  // Many instances name the channel after the stream, which would print the
  // same string twice. Fall back to the server it lives on — more useful anyway.
  const named = profile?.name;
  const host =
    named && named.trim() !== channel.title.trim()
      ? named
      : (hostname(channel.proxyUrl) ?? named ?? 'a self-hosted stream');

  el.innerHTML = `
    <div class="card-thumb">
      ${channel.image ? `<img src="${escapeAttr(channel.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <span class="card-live">live</span>
    </div>
    <div class="card-body">
      <p class="card-title">${escapeHtml(channel.title)}</p>
      <p class="card-host">${escapeHtml(host)}</p>
    </div>`;

  // A dead thumbnail on someone else's server must not leave a broken image.
  el.querySelector('img')?.addEventListener('error', (event) => {
    (event.currentTarget as HTMLImageElement).remove();
  });

  return el;
}

function hostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
