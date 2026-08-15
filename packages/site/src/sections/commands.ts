import { config, relayHost } from '../config';
import { escapeHtml } from '../ui/escape';

export interface CommandCard {
  what: string;
  /** Written as you'd type it into nak. Grimoire runs the same string minus `nak `. */
  cmd: string;
}

/**
 * The commands are the proof. Each one is a claim from further up the page,
 * restated as something the reader can run — `nak` in a terminal, or the same
 * string in Grimoire without installing anything.
 */
export function defaultCommands(): CommandCard[] {
  const events = relayHost(config.eventRelay);
  const chat = relayHost(config.chatRelay);
  return [
    {
      what: 'The discovery relay, describing its own policy (NIP-11).',
      cmd: `nak relay wss://${events}`,
    },
    {
      what: 'Every stream Livelier has ever announced, newest first.',
      cmd: `nak req -k 30311 -l 200 wss://${events}`,
    },
    {
      what: 'How many — one number, straight from the relay (NIP-45).',
      cmd: `nak count -k 30311 wss://${events}`,
    },
    {
      what: 'Every bridged chat message currently held. Run it again tomorrow: the old ones are gone.',
      cmd: `nak req -k 1311 -l 100 wss://${chat}`,
    },
    {
      what: 'The chat relay, and the retention window it commits to.',
      cmd: `nak relay wss://${chat}`,
    },
  ];
}

/** Grimoire speaks nak's command language; it just doesn't want the program name. */
export function grimoireUrl(cmd: string): string {
  return config.grimoireRun + encodeURIComponent(cmd.replace(/^nak\s+/, ''));
}

/** Minimal highlighting: flags in gold, relay URLs in blue. */
function highlight(cmd: string): string {
  return cmd
    .split(' ')
    .map((token) => {
      const safe = escapeHtml(token);
      if (/^wss?:\/\//.test(token)) return `<span class="url">${safe}</span>`;
      if (/^-/.test(token)) return `<span class="flag">${safe}</span>`;
      return safe;
    })
    .join(' ');
}

export function renderCommandCard(card: CommandCard): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cmd';
  el.innerHTML = `
    <p class="cmd-what">${escapeHtml(card.what)}</p>
    <div class="cmd-line"><code>${highlight(card.cmd)}</code></div>
    <div class="cmd-actions">
      <button type="button" class="cmd-btn copy">Copy</button>
      <a class="cmd-btn" href="${grimoireUrl(card.cmd)}" target="_blank" rel="noopener">Run in Grimoire ↗</a>
    </div>`;

  const button = el.querySelector<HTMLButtonElement>('.copy');
  button?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(card.cmd);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Press ⌘C';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });

  return el;
}

export function renderCommands(container: HTMLElement, cards: CommandCard[]): void {
  container.replaceChildren(...cards.map(renderCommandCard));
}
