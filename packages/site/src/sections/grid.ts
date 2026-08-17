import type { Channel, ChannelProfile } from '../nostr/queries';
import { escapeAttr, escapeHtml, safeHref } from '../ui/escape';

/**
 * The currently-live channels, as cards.
 *
 * Each card links to the streamer's own server, not to a player Livelier hosts —
 * which is the whole promise of the bridge restated as a hyperlink: discovery
 * happens on the directory, viewing happens on your machine.
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
  const href = safeHref(channel.proxyUrl) ?? safeHref(profile?.website);
  const thumb = safeHref(channel.image);

  const el = document.createElement('a');
  el.className = 'card';
  el.setAttribute('data-reveal', '');

  // An anchor with no href is still an anchor, and `.card` styles it either
  // way — so a channel that published an address this page won't follow simply
  // renders as a card that doesn't click, rather than as a link to nowhere.
  if (href) {
    el.href = href;
    el.target = '_blank';
    el.rel = 'noopener';
  }

  // Many instances name the channel after the stream, which would print the
  // same string twice. Fall back to the server it lives on — more useful anyway.
  const named = profile?.name;
  const host =
    named && named.trim() !== channel.title.trim()
      ? named
      : (hostname(channel.proxyUrl) ?? named ?? 'a self-hosted stream');

  el.innerHTML = `
    <div class="card-thumb">
      ${thumb ? `<img src="${escapeAttr(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
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

