/**
 * CLI argument parser for operations scripts.
 *
 * Parses --flag value pairs from process.argv. No npm dependencies.
 *
 * Usage:
 *   import { parseArgs } from './arg-parser.mjs';
 *
 *   const { flags, positional } = parseArgs(process.argv.slice(2), {
 *     aliases: { '-e': '--env', '-f': '--format' },
 *     booleans: ['--confirm', '--help', '--verbose'],
 *     defaults: { '--env': 'staging', '--format': 'auto' },
 *   });
 *
 *   flags['--env']     // 'staging'
 *   flags['--confirm'] // true | false
 *   positional         // ['https://instance.example']
 */


/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv - Typically process.argv.slice(2)
 * @param {object} opts
 * @param {Record<string, string>} [opts.aliases]  - Short flag -> long flag mapping
 * @param {string[]}              [opts.booleans]  - Flags that take no value (presence = true)
 * @param {Record<string, string>} [opts.defaults] - Default values for flags
 * @returns {{ flags: Record<string, string | boolean>, positional: string[] }}
 */
export function parseArgs(argv, opts = {}) {
  const aliases = opts.aliases || {};
  const booleans = new Set(opts.booleans || []);
  const defaults = opts.defaults || {};

  const flags = { ...defaults };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];

    // Resolve alias
    if (aliases[key]) {
      key = aliases[key];
    }

    if (key.startsWith('--')) {
      if (booleans.has(key)) {
        flags[key] = true;
      } else {
        const next = argv[i + 1];
        const nextIsFlag =
          !next ||
          next.startsWith('--') ||
          aliases[next] !== undefined;
        if (nextIsFlag) {
          flags[key] = true;
        } else {
          flags[key] = argv[++i];
        }
      }
    } else if (key.startsWith('-')) {
      // Short flag not listed in aliases — treat as unknown boolean
      flags[key] = true;
    } else {
      positional.push(argv[i]);
    }
  }

  return { flags, positional };
}

