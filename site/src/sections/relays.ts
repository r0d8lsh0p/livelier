import { config } from '../config';
import { fetchRelayInfo, type RelayInfo } from '../nostr/queries';

/**
 * Fill the two relay cards from each relay's own NIP-11 document.
 *
 * The description on the chat relay states its retention window verbatim
 * ("All events except kinds 0 are deleted after 3h0m0s"). Printing the relay's
 * own words — rather than our summary of them — is the point: the claim and
 * the enforcement come from the same place, and the reader can fetch it too.
 */
export async function hydrateRelayCards(): Promise<RelayInfo | null> {
  const [eventInfo, chatInfo] = await Promise.all([
    fetchRelayInfo(config.eventRelay),
    fetchRelayInfo(config.chatRelay),
  ]);

  fill('#relay-event', config.eventRelay, config.eventRelayLabel, eventInfo, config.sw2Repo);
  fill('#relay-chat', config.chatRelay, config.chatRelayLabel, chatInfo, config.ephemeralRelayRepo);

  return chatInfo;
}

function fill(
  selector: string,
  wssUrl: string,
  label: string,
  info: RelayInfo | null,
  repo: string
): void {
  const card = document.querySelector<HTMLElement>(selector);
  if (!card) return;

  const name = card.querySelector<HTMLElement>('.relay-name');
  const host = card.querySelector<HTMLElement>('.relay-host code');
  const desc = card.querySelector<HTMLElement>('.relay-desc');
  const nips = card.querySelector<HTMLElement>('.relay-nips');

  if (host) host.textContent = wssUrl;

  // The pulse is earned, not decorative: it only appears once the relay has
  // answered with its own document, so a dark dot means genuinely unreachable.
  card.classList.toggle('relay-online', Boolean(info));

  if (!info) {
    if (name) name.textContent = label;
    if (desc) {
      desc.textContent =
        'This relay could not be reached just now — which you can check yourself with the commands below.';
    }
    if (nips) nips.textContent = '';
    return;
  }

  if (name) name.textContent = label;
  if (desc) desc.textContent = info.description ?? '';

  if (nips) renderNips(nips, info.supported_nips ?? []);

  // The relay's source, given its own line rather than buried in the NIP list —
  // "read the code" is the strongest claim on the page and should look like one.
  const source = card.querySelector<HTMLAnchorElement>('.relay-source a');
  if (source) {
    const name = info.software ? softwareName(info.software) : 'the relay';
    source.href = repo;
    source.textContent = `${name}${info.version ? ` ${info.version}` : ''} on GitHub ↗`;
  }
}

/**
 * Each NIP as its own chip, built as elements rather than markup — these
 * numbers come off the relay's document, and nothing from a relay is ever
 * interpolated into HTML.
 */
function renderNips(target: HTMLElement, supported: number[]): void {
  target.replaceChildren();
  if (supported.length === 0) return;

  target.append('Supports ');
  for (const nip of [...supported].sort((a, b) => a - b)) {
    const chip = document.createElement('a');
    chip.className = 'nip';
    chip.href = config.nip(nip);
    chip.target = '_blank';
    chip.rel = 'noopener';
    chip.textContent = `NIP-${nip}`;
    target.append(chip);
  }
}

/**
 * `https://github.com/bitvora/sw2` → `sw2`. No escaping: every caller now
 * assigns it through textContent.
 */
function softwareName(software: string): string {
  return software.replace(/\/$/, '').split('/').pop() || software;
}

/**
 * Pull the retention window out of the chat relay's own description so the
 * sentence in the chat section can't drift from the relay's actual policy.
 * `3h0m0s` → `3 hours`.
 */
export function retentionPhrase(info: RelayInfo | null): string | null {
  const match = info?.description?.match(/deleted after (\d+)h(?:(\d+)m)?/i);
  if (!match) return null;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours === 1 ? 'one hour' : `${hours} hours`;
}

/**
 * The retention window as currently rendered, for copy elsewhere on the page.
 * Reads the element the relay's own value was written into, so there is one
 * source for it and no second cache to fall out of step.
 */
export function currentRetentionPhrase(): string {
  return document.querySelector('#ttl-window')?.textContent?.trim() || 'three hours';
}

/**
 * The chat relay's NIP-11 description, verbatim, for quoting elsewhere on the
 * page. Read from the card it was rendered into for the same reason as above:
 * one fetch, one copy, no second cache to drift.
 */
export function currentChatRelayPolicy(): string {
  const rendered = document.querySelector('#relay-chat .relay-desc')?.textContent?.trim();
  return rendered && rendered !== '…'
    ? rendered
    : 'The relay states its own retention window in its NIP-11 document.';
}

