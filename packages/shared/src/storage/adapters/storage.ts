/**
 * @file Node filesystem storage adapter
 *
 * Persists each key as one JSON-safe file under STORAGE_DIR (default
 * `.data/` in the working directory), written atomically via temp+rename
 * so a crash mid-write can never corrupt a cache. This backs the profile
 * caches, so warm boots skip refetching every known profile from relays.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IStorageAdapter } from '../types';

const STORAGE_DIR = process.env.STORAGE_DIR || '.data';

/** Unique temp-file suffix per write — concurrent writes to one key must
 * never share a temp path (the loser's rename would ENOENT). */
let writeSeq = 0;

/** Keys become filenames: keep them readable, make collisions impossible. */
function fileFor(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return path.join(STORAGE_DIR, `${safe}-${hash}.json`);
}

const storageAdapter: IStorageAdapter = {
  async setItem(key: string, value: string): Promise<void> {
    await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
    const target = fileFor(key);
    const tmp = `${target}.${process.pid}.${writeSeq++}.tmp`;
    await fs.promises.writeFile(tmp, value, 'utf8');
    await fs.promises.rename(tmp, target);
  },

  async getItem(key: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(fileFor(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },

  async deleteItem(key: string): Promise<void> {
    try {
      await fs.promises.unlink(fileFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
      await fs.promises.access(STORAGE_DIR, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export default storageAdapter;
