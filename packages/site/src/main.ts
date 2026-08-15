import { config } from './config';
import { setClientName } from './seam/shared';
import {
  bridgeAuthored,
  fetchChannelProfiles,
  fetchChannels,
  fetchChatMessages,
  fetchCreatorCount,
  type Channel,
} from './nostr/queries';
import { countUp, initProgressBar, initReveal } from './ui/motion';
import { preciseDelta } from './ui/escape';
import { renderLiveGrid } from './sections/grid';
import { hydrateRelayCards, retentionPhrase } from './sections/relays';
import { defaultCommands, renderCommands } from './sections/commands';
import { initFinder } from './sections/finder';
import { initChatSample } from './sections/chat-sample';

/**
 * The page is readable before any of this runs — every claim is in the HTML.
 * Everything here is enrichment: real numbers, real channels, the relays'
 * own words. A relay that doesn't answer costs the reader nothing.
 */

let liveChannels: Channel[] = [];

function main(): void {
  setClientName('Livelier site');

  initProgressBar();
  const reveal = initReveal();

  wireStaticLinks();
  initFinder(reveal, () => liveChannels);
  initChatSample(reveal);

  const commands = document.querySelector<HTMLElement>('#cmds');
  if (commands) renderCommands(commands, defaultCommands());

  void loadChannels(reveal);
  void loadChatCount();
  void loadRelays();
}

/** Links that come from config rather than being hard-coded in the markup. */
function wireStaticLinks(): void {
  setHref('#cta-issue', config.newIssue);
}

function setHref(selector: string, href: string): void {
  const el = document.querySelector<HTMLAnchorElement>(selector);
  if (el) el.href = href;
}

async function loadChannels(reveal: (root?: ParentNode) => void): Promise<void> {
  const grid = document.querySelector<HTMLElement>('#live-grid');

  let channels: Channel[];
  let reached: boolean;
  try {
    ({ channels, reached } = await fetchChannels());
  } catch {
    unreachable(grid);
    return;
  }

  // No relay answered. Say nothing rather than reporting zero — an empty answer
  // and an unasked question look identical from here, and only one of them is a
  // fact about the bridge.
  if (!reached) {
    unreachable(grid);
    return;
  }

  liveChannels = channels.filter((channel) => channel.status === 'live');
  setCount('#stat-live', liveChannels.length);

  // Every live event is authored by the bridge itself; its own profile sits on
  // the chat relay alongside the creators', so exclude it from the count.
  const bridgeKeys = new Set(channels.map((channel) => channel.event.pubkey));
  void fetchCreatorCount(bridgeKeys)
    .then((count) => {
      if (count !== null) setCount('#stat-creators', count);
    })
    .catch(() => undefined);

  if (!grid) return;

  // Newest session first, so the grid leads with whoever just went live.
  const ordered = [...liveChannels].sort((a, b) => (b.starts ?? 0) - (a.starts ?? 0));
  // Three rows of three. Mobile hides all but the first four in CSS.
  const shown = ordered.slice(0, 9);

  const hostKeys = shown.map((channel) => channel.hostPubkey).filter((k): k is string => Boolean(k));
  const profiles = await fetchChannelProfiles(hostKeys).catch(() => new Map());

  renderLiveGrid(grid, shown, profiles);
  reveal(grid);
}

async function loadChatCount(): Promise<void> {
  let messages: Channel['event'][];
  try {
    // Bridge-authored only, so this count agrees with the example below it —
    // the relay also holds messages Nostr clients posted to it directly.
    const { events, reached } = await fetchChatMessages();
    if (!reached) return;
    messages = bridgeAuthored(events);
  } catch {
    return;
  }
  setCount('#stat-chat-inline', messages.length);

  // The oldest message is the claim's own evidence: if the relay is deleting on
  // schedule, this number never reaches the stated window.
  const oldest = messages.reduce<number | null>(
    (min, event) => (min === null || event.created_at < min ? event.created_at : min),
    null
  );
  if (oldest === null) return;
  setText('#chat-oldest', ` The oldest is ${preciseDelta(oldest).replace(/ ago$/, '')} old.`);
}

async function loadRelays(): Promise<void> {
  const chatInfo = await hydrateRelayCards();

  // The retention window is the relay's to state, not ours. Both the hero tile
  // and the sentence in the chat section take it from the NIP-11 document, so
  // neither can drift from the policy actually being enforced. When the relay
  // cannot be read the hero tile stays at its dash — unknown is not "3 hours".
  const phrase = retentionPhrase(chatInfo);
  if (!phrase) return;

  setText('#ttl-window', phrase);
  setText('#stat-ttl', titleCase(phrase));
}

/** Leave the counters at their placeholder and say the grid could not be read. */
function unreachable(grid: HTMLElement | null): void {
  if (!grid) return;
  grid.innerHTML =
    '<p class="grid-empty">The bridge relay could not be reached from your browser just now, so' +
    ' this list is unknown rather than empty. The commands further down will tell you the same' +
    ' thing independently.</p>';
}

function setText(selector: string, value: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) el.textContent = value;
}

/** "3 hours" → "3 Hours", for the stat tile. */
function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function setCount(selector: string, value: number): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) countUp(el, value);
}

main();
