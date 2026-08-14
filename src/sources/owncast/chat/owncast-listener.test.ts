import type { Logger } from 'pino';
import {
  OwncastChatJoin,
  OwncastChatListener,
  OwncastChatMessage,
  parseOwncastFrames,
} from './owncast-listener';

const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

/** Feed raw frames into a listener without a live websocket. */
function feedFrame(listener: OwncastChatListener, frame: string): void {
  (listener as unknown as { handleFrame: (data: string) => void }).handleFrame(frame);
}

describe('OwncastChatListener frame routing', () => {
  it('emits join for USER_JOINED frames, skipping its own registration', () => {
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    listener.ownUserId = 'self-id';
    const joins: OwncastChatJoin[] = [];
    const chats: OwncastChatMessage[] = [];
    listener.on('join', (j: OwncastChatJoin) => joins.push(j));
    listener.on('chat', (c: OwncastChatMessage) => chats.push(c));

    feedFrame(
      listener,
      JSON.stringify({ type: 'USER_JOINED', user: { id: 'u1', displayName: 'zen-cherry' } }) +
        '\n' +
        JSON.stringify({ type: 'USER_JOINED', user: { id: 'self-id', displayName: 'Livelier' } }) +
        '\n' +
        JSON.stringify({ type: 'CHAT', user: { id: 'u2', displayName: 'bob' }, body: 'hi' })
    );

    expect(joins).toEqual([{ userId: 'u1', displayName: 'zen-cherry' }]);
    expect(chats).toEqual([{ userId: 'u2', displayName: 'bob', body: 'hi' }]);
  });

  it('ignores frames with no user id (system events)', () => {
    const listener = new OwncastChatListener('https://oc.example', 'Livelier', noopLog);
    const joins: OwncastChatJoin[] = [];
    listener.on('join', (j: OwncastChatJoin) => joins.push(j));
    feedFrame(listener, JSON.stringify({ type: 'USER_JOINED' }));
    expect(joins).toHaveLength(0);
  });
});

describe('parseOwncastFrames', () => {
  it('parses a single JSON frame', () => {
    const frames = parseOwncastFrames('{"type":"CHAT","body":"hi"}');
    expect(frames).toEqual([{ type: 'CHAT', body: 'hi' }]);
  });

  it('parses newline-batched frames', () => {
    const frames = parseOwncastFrames('{"type":"CHAT"}\n{"type":"USER_JOINED"}\n');
    expect(frames.map((f) => f.type)).toEqual(['CHAT', 'USER_JOINED']);
  });

  it('skips blank lines and non-JSON garbage', () => {
    const frames = parseOwncastFrames('\n\nnot-json\n{"type":"CHAT"}');
    expect(frames).toHaveLength(1);
  });
});
