import { config } from '../config';
import {
  bridgeAuthored,
  fetchChatMessages,
  fetchProfile,
  tag,
  tags,
  type ChannelProfile,
} from '../nostr/queries';
import type { NostrEvent } from '../seam/shared';
import { njumpEvent } from '../nostr/njump';
import { escapeHtml, preciseDelta } from '../ui/escape';
import { openJsonDialog } from '../ui/json-dialog';
import { currentRetentionPhrase, currentChatRelayPolicy } from './relays';

/**
 * "Show me an example chat message" — pulls a real bridged message off the chat
 * relay, renders it the way a client would, and then shows what is attached to
 * it: the expiry, the protection tag, and the relay's own stated policy.
 *
 * The same move as the stream lookup: rather than describing the guarantees,
 * show an actual event carrying them. If nothing comes back, that is the
 * guarantee demonstrating itself — everything older than the window is gone.
 */
export function initChatSample(onReveal: (root?: ParentNode) => void): void {
  const button = document.querySelector<HTMLButtonElement>('#chat-sample');
  const result = document.querySelector<HTMLElement>('#chat-sample-result');
  if (!button || !result) return;

  button.addEventListener('click', async () => {
    result.innerHTML = '<p class="result-note">Asking the relay…</p>';

    let messages: NostrEvent[];
    try {
      const { events, reached } = await fetchChatMessages();
      if (!reached) {
        result.innerHTML =
          '<p class="result-note">The chat relay could not be reached from your browser just now.' +
          ' That is not the same as it being empty — try again in a moment.</p>';
        return;
      }
      messages = bridgeAuthored(events);
    } catch {
      result.innerHTML = '<p class="result-note">The chat relay could not be reached just now.</p>';
      return;
    }

    if (messages.length === 0) {
      result.innerHTML = `<p class="result-note">There are no bridge-created chat messages on the
        relay at this moment. Anything older than ${escapeHtml(currentRetentionPhrase())} has
        already been deleted. Try again while a bridged stream has a conversation going.</p>`;
      return;
    }

    const message = messages[Math.floor(Math.random() * messages.length)];
    const profile = await fetchProfile(message.pubkey).catch(() => undefined);

    result.replaceChildren(sampleCard(message, profile));
    onReveal(result);
  });
}

function sampleCard(message: NostrEvent, profile: ChannelProfile | undefined): HTMLElement {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.setAttribute('data-reveal', '');

  const name = profile?.name ?? 'Guest';
  const expiration = Number(tag(message, 'expiration'));
  const isProtected = message.tags.some((t) => t[0] === '-');
  const room = tags(message, 'a')[0];

  card.innerHTML = `
    <p class="sample-label">A real message, on the relay right now</p>

    <div class="chat-lockup">
      ${avatar(profile, name)}
      <div class="chat-lockup-body">
        <p class="chat-lockup-name">${escapeHtml(name)}
          <span class="chat-lockup-time">${escapeHtml(preciseDelta(message.created_at))}</span>
        </p>
        <p class="chat-lockup-msg">${escapeHtml(message.content)}</p>
      </div>
    </div>

    <div class="callout callout-expiry">
      <p class="callout-head">${
        Number.isFinite(expiration)
          ? `Expires ${escapeHtml(preciseDelta(expiration))}`
          : 'No expiry attached'
      }</p>
      <p>${
        Number.isFinite(expiration)
          ? `<strong>Every bridged message carries an expiry
             (<a href="${config.nip(40)}" target="_blank" rel="noopener">NIP-40</a>).</strong>
             Clients that honour the tag stop showing it at that moment, wherever it reached.`
          : `<strong>This message has no
             <a href="${config.nip(40)}" target="_blank" rel="noopener">NIP-40</a> tag.</strong>
             The relay still deletes it on its own schedule.`
      }</p>
    </div>

    <div class="callout callout-protect">
      <p class="callout-head">${isProtected ? 'Marked do-not-share' : 'Not marked as protected'}</p>
      <p>${
        isProtected
          ? `<strong>Tagged <code>-</code> under
             <a href="${config.nip(70)}" target="_blank" rel="noopener">NIP-70</a>.</strong>
             An honest relay anywhere else refuses it from anyone but its author, so it should
             not be distributed by a client or an aggregator.`
          : `<strong>This message carries no
             <a href="${config.nip(70)}" target="_blank" rel="noopener">NIP-70</a> marker.</strong>`
      }</p>
    </div>

    <div class="callout callout-policy">
      <p class="callout-head">The relay's own policy</p>
      <p><strong><a href="${config.nip(11)}" target="_blank" rel="noopener">NIP-11</a>, states the
      relay:</strong> “${escapeHtml(currentChatRelayPolicy())}”</p>
    </div>

    ${room
      ? `<p class="result-note">It is tagged to one room — <code>${escapeHtml(room)}</code> —
         which is how it reaches that stream's chat and no other.</p>`
      : ''}

    <div class="result-actions">
      <button type="button" class="cmd-btn" data-json>View the raw event</button>
      <a class="cmd-btn" href="${njumpEvent(message, config.chatRelay)}" target="_blank" rel="noopener">Open it on njump ↗</a>
    </div>`;

  card.querySelector<HTMLButtonElement>('[data-json]')?.addEventListener('click', () => {
    openJsonDialog(message, 'The message, exactly as the relay holds it');
  });

  return card;
}

/** Bridged chatters usually have no picture; fall back to their initial. */
function avatar(profile: ChannelProfile | undefined, name: string): string {
  if (profile?.picture) {
    return `<img class="chat-avatar" src="${escapeHtml(profile.picture)}" alt=""
      loading="lazy" referrerpolicy="no-referrer">`;
  }
  return `<span class="chat-avatar chat-avatar-initial">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
}
