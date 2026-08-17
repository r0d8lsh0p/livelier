import { nip19 } from 'nostr-tools';
import { ProfileInfo } from '../../nostr/services/profile.service';
import type { ChatMessage } from '../../nostr/services/nostr-chat.service';

/**
 * Represents a token in the processed content
 */
export interface ContentToken {
  type: string;          // Type of token (e.g., 'text', 'user', 'url')
  value: string;         // Text value of the token
  metadata?: any;        // Additional data about the token
}

/**
 * Represents a replacement made in the content
 */
export interface ContentReplacement {
  type: string;          // Type of replacement (e.g., 'mention', 'hashtag', 'url')
  originalText: string;  // Original text that was replaced
  displayText: string;   // Text displayed to the user
  metadata: any;         // Additional data about the replacement
  indices: [number, number]; // Start and end indices in the processed text
}

/**
 * Result of content processing
 */
export interface ProcessedContent {
  text: string;                     // The processed text for display
  replacements: ContentReplacement[]; // All replacements made (deprecated)
  tokens?: ContentToken[];          // Tokenized representation of the content (optional for backward compatibility)
}

/**
 * Result of a processor's processing function
 */
export interface ProcessorResult {
  result: string;             // The text to replace the match with
  metadata?: any;             // Additional metadata about the replacement
}

/**
 * Context passed to processors
 */
export interface ProcessorContext {
  [key: string]: any;         // Allow for context properties
}

/**
 * Interface for content processors
 */
export interface ContentProcessor {
  id: string;                 // Unique identifier for the processor
  // For in-content processors
  pattern?: RegExp;           // Pattern to match in content
  // For message-level processors
  messageKind?: number;       // Nostr event kind this processor handles
  // Processing function - now returns a Promise
  process: (
    input: string | ChatMessage,
    ...args: any[]
  ) => Promise<ProcessorResult>;
  priority?: number;          // Optional priority (higher = processed first)
}

/**
 * Options for content processing
 */
export interface ProcessingOptions {
  processors?: string[];      // IDs of processors to use (all if not specified)
  context?: ProcessorContext; // Additional context for processors
}
