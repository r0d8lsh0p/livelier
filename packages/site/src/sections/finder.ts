import { config } from '../config';
import { coerceInstanceUrl, dTagFor } from '../nostr/dtag';
import {
  fetchChannelByDTag,
  fetchRoomChatCount,
  roomCoordinate,
  type Channel,
} from '../nostr/queries';
import { currentRetentionPhrase } from './relays';
import { countUp } from '../ui/motion';
import { openJsonDialog } from '../ui/json-dialog';
import { escapeAttr, escapeHtml, safeHref } from '../ui/escape';
import { njumpAddress } from '../nostr/njump';

interface FinderElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
  result: HTMLElement;
  random: HTMLButtonElement;
}

/**
 * "What do you know about my stream?" — answered by fetching the actual event.
 *
 * The id is recomputed here from the address alone (see nostr/dtag.ts); the
 * channel's key is then read off the event's `p` tag. Nothing on this page can
 * derive a key, and it is worth saying so where a streamer will see it.
 */
export function initFinder(
  onReveal: (root?: ParentNode) => void,
  liveSamples: () => Channel[]
): void {
  const elements = collect();
  if (!elements) return;

  elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await lookup(elements, elements.input.value, onReveal);
  });

  elements.random.addEventListener('click', async () => {
    const candidates = liveSamples().filter((channel) => channel.proxyUrl);
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    elements.input.value = pick.proxyUrl ?? '';
    await lookup(elements, elements.input.value, onReveal);
  });
}

function collect(): FinderElements | null {
  const form = document.querySelector<HTMLFormElement>('#finder-form');
  const input = document.querySelector<HTMLInputElement>('#finder-input');
  const result = document.querySelector<HTMLElement>('#finder-result');
  const random = document.querySelector<HTMLButtonElement>('#finder-random');
  if (!form || !input || !result || !random) return null;
  return { form, input, result, random };
}

async function lookup(
  elements: FinderElements,
  raw: string,
  onReveal: (root?: ParentNode) => void
): Promise<void> {
  const url = coerceInstanceUrl(raw);
  if (!url) {
    note(elements.result, "That doesn't look like a web address — try something like <code>live.example.com</code>.");
    return;
  }

  note(elements.result, 'Asking the relay…');

  let dTag: string;
  let channel: Channel | null;
  let reached: boolean;
  try {
    dTag = await dTagFor(url, config.owncastDTagPrefix);
    ({ channel, reached } = await fetchChannelByDTag(dTag));
  } catch {
    note(elements.result, 'Something went wrong asking the relay. Try again in a moment.');
    return;
  }

  // "Nothing published for you" is a claim about the bridge. Only make it when
  // a relay actually answered — otherwise a transient outage tells a bridged
  // streamer they are not bridged.
  if (!reached) {
    note(
      elements.result,
      `The relay could not be reached from your browser just now, so this is unknown rather than
       empty. Your channel's id would be <code>${escapeHtml(dTag)}</code> — the commands further
       down will look it up independently.`
    );
    return;
  }

  if (!channel) {
    note(
      elements.result,
      `Nothing published for <code>${escapeHtml(new URL(url).hostname)}</code>. Either it isn't listed in the
       public Owncast directory, or it hasn't gone live since Livelier started watching.
       Its id would be <code>${escapeHtml(dTag)}</code> if it ever does.`
    );
    return;
  }

  const card = resultCard(channel);
  elements.result.replaceChildren(card);
  onReveal(elements.result);

  // Chat is a second round trip; the card is useful without it.
  void fillChatCount(card, channel);
}

function resultCard(channel: Channel): HTMLElement {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.setAttribute('data-reveal', '');

  const statusClass = channel.status === 'live' ? 'live' : 'ended';
  const serverUrl = channel.proxyUrl;
  // Shown as a link only if it is one this page will follow; otherwise the
  // address is still printed, just as text.
  const serverHref = safeHref(serverUrl);
  const watchUrl = channel.streaming ?? channel.proxyUrl;

  card.innerHTML = `
    <h3>${escapeHtml(channel.title)}</h3>
    ${channel.summary ? `<p class="result-summary">${escapeHtml(channel.summary)}</p>` : ''}
    ${serverUrl
      ? `<p class="result-url">${
          serverHref
            ? `<a href="${escapeAttr(serverHref)}" target="_blank" rel="noopener">${escapeHtml(serverUrl)}</a>`
            : escapeHtml(serverUrl)
        }</p>`
      : ''}
    <div class="result-meta">
      <span class="pill ${statusClass}">${escapeHtml(channel.status)}</span>
      ${channel.nsfw ? '<span class="pill">labelled adult</span>' : ''}
      ${channel.topics.slice(0, 3).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('')}
    </div>

    <div class="callout callout-server">
      <p class="callout-head">Live streaming at ${watchUrl ? `<code>${escapeHtml(watchUrl)}</code>` : 'your own server'}</p>
      <p><strong>Livelier never copies, re-hosts, or stores your video.</strong> It publishes the
      above URL so that viewers know where to watch.</p>
    </div>

    <div class="callout callout-chat">
      <p class="callout-head">Chat messages for this livestream</p>
      <div class="chat-count">
        <span class="chat-count-value" data-chat-value>—</span>
        <p class="chat-count-text" data-chat-text>Counting…</p>
      </div>
    </div>

    <div class="result-actions">
      <button type="button" class="cmd-btn" data-json>View the raw event</button>
      <a class="cmd-btn" href="${njumpAddress(channel.event, channel.dTag)}" target="_blank" rel="noopener">Open it on njump ↗</a>
    </div>`;

  card.querySelector<HTMLButtonElement>('[data-json]')?.addEventListener('click', () => {
    openJsonDialog(channel.event);
  });

  return card;
}

async function fillChatCount(card: HTMLElement, channel: Channel): Promise<void> {
  const value = card.querySelector<HTMLElement>('[data-chat-value]');
  const text = card.querySelector<HTMLElement>('[data-chat-text]');
  if (!value || !text) return;

  let count: number | null;
  try {
    count = await fetchRoomChatCount(roomCoordinate(channel));
  } catch {
    count = null;
  }

  if (count === null) {
    value.textContent = '?';
    text.textContent = 'The chat relay could not be reached just now.';
    return;
  }

  countUp(value, count);

  const plural = count === 1 ? 'message' : 'messages';
  // "bridged chat messages … are bridged" would say it twice; the verb carries it.
  text.innerHTML = `<strong>chat ${plural}</strong> are bridged for this live stream right now.
    Any that arrive are deleted within ${escapeHtml(currentRetentionPhrase())}.`;
}

function note(container: HTMLElement, html: string): void {
  container.innerHTML = `<p class="result-note">${html}</p>`;
}

