import { registerProcessor } from '../registry';

// Import processors
import { npubProcessor } from './npub-processor';
import { nprofileProcessor } from './nprofile-processor';
import { urlProcessor } from './url-processor';
import { reactionProcessor } from './reaction-processor';
import { zapProcessor } from './zap-processor';
import { noteProcessor } from './note-processor';
import { neventProcessor } from './nevent-processor';
import { naddrProcessor } from './naddr-processor';
import { emojiProcessor } from './emoji-processor';

// Register all processors
export function registerAllProcessors() {
  registerProcessor(npubProcessor);
  registerProcessor(nprofileProcessor);
  registerProcessor(urlProcessor);
  registerProcessor(emojiProcessor);
  registerProcessor(reactionProcessor);
  registerProcessor(zapProcessor);
  registerProcessor(noteProcessor);
  registerProcessor(neventProcessor);
  registerProcessor(naddrProcessor);
}

// Export all processors
export {
  npubProcessor,
  nprofileProcessor,
  urlProcessor,
  emojiProcessor,
  reactionProcessor,
  zapProcessor,
  noteProcessor,
  neventProcessor,
  naddrProcessor
};
