import { nip19 } from 'nostr-tools';
import { ContentProcessor, ProcessorResult } from '../types';
import type { ChatMessage } from '../../../nostr/services/nostr-chat.service';
import profileService from '../../../nostr/services/profile.service';
import { abridgeBech32Id } from '../../nostr-key-utils';

/**
 * Regular expression to match npub identifiers in text
 * Matches both with and without nostr: prefix
 */
export const NPUB_REGEX = /(nostr:)?(npub1[a-z0-9]{58})/g;

/**
 * Processor for npub identifiers - fully asynchronous
 */
export const npubProcessor: ContentProcessor = {
  id: 'npub',
  priority: 5,
  pattern: NPUB_REGEX,
  process: async (match: string | ChatMessage, prefix: string, npub: string, offset: number, fullContent: string, context: any): Promise<ProcessorResult> => {
    try {
      // Handle the case when match is a ChatMessage (should never happen for pattern processors)
      const matchText = typeof match === 'string' ? match : match.content || '';
      
      // Check if there's an @ symbol right before the match
      const hasAtSymbol = offset > 0 && fullContent[offset - 1] === '@';
      
      // Decode the npub to get the pubkey
      const { type, data } = nip19.decode(npub);
      
      if (type !== 'npub') {
        return { result: matchText }; // Not a valid npub
      }
      
      const pubkey = data as string;
      
      // Directly fetch the profile asynchronously
      try {
        // Fetch profile using profileService
        const profile = await profileService.getProfile(pubkey);
        
        // If profile found, use the name
        if (profile && profile.name) {
          // Only add @ if there isn't one already
          const displayText = hasAtSymbol ? profile.name : `@${profile.name}`;
          
          return {
            result: displayText,
            metadata: {
              type: 'mention',
              originalText: matchText,
              pubkey,
              name: profile.name
            }
          };
        }
      } catch (profileError) {
        console.warn('Error fetching profile:', profileError);
        // Fall through to return original text
      }
      
      const abridged = abridgeBech32Id(npub);
      
      // Return abridged text with metadata if profile fetch failed
      return { 
        result: abridged,
        metadata: {
          type: 'mention',
          originalText: matchText,
          pubkey,
          name: abridged
        }
      };
    } catch (error) {
      console.warn('Error processing npub:', error);
      return { result: typeof match === 'string' ? match : match.content || '' };
    }
  }
};
