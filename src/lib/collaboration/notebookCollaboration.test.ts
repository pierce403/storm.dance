import { describe, it, expect } from 'vitest';
import { NotebookCollaborationSession, type XmtpClientLike } from './notebookCollaboration';
import type { CrdtUpdatePayload } from './types';
import type { Conversation } from '@xmtp/browser-sdk';

interface MockMessage {
  senderInboxId: string;
  content: unknown;
}

class MockConversation {
  sent: string[] = [];
  constructor(public peerAddress: string, private incoming: MockMessage[] = []) {}

  async send(content: unknown) {
    this.sent.push(typeof content === 'string' ? content : JSON.stringify(content));
  }

  async stream(onMessage: (error: Error | null, message?: MockMessage) => void) {
    for (const message of this.incoming) {
      onMessage(null, message);
    }
  }
}

class MockClient {
  address = '0x0011223344556677889900112233445566778899';
  inboxId = 'self-inbox';
  conversationsCreated: MockConversation[] = [];
  incomingQueues: MockMessage[][] = [];

  canMessage = async (identifiers: Array<{ identifier: string }>) =>
    new Map(identifiers.map((identifier) => [identifier.identifier, true]));

  enqueueIncoming(messages: MockMessage[]) {
    this.incomingQueues.push(messages);
  }

  conversations = {
    newDmWithIdentifier: async (identifier: { identifier: string }) => {
      const messages = this.incomingQueues.shift() || [];
      const conversation = new MockConversation(identifier.identifier, messages);
      this.conversationsCreated.push(conversation);
      return conversation as unknown as Conversation;
    },
  };
}

const buildRemoteMessage = (payload: CrdtUpdatePayload): MockMessage => ({
  senderInboxId: 'peer-inbox',
  content: JSON.stringify({ type: 'crdt-update', payload }),
});

describe('NotebookCollaborationSession', () => {
  it('broadcasts CRDT updates to every collaborator', async () => {
    const client = new MockClient();
    const session = new NotebookCollaborationSession({
      notebookId: 'nb-1',
      client: client as unknown as XmtpClientLike,
      onRemoteUpdate: () => {},
      debugLoggingEnabled: false,
    });

    await session.start([{ address: '0x1234567890123456789012345678901234567890' }], 'Team Notes');
    await session.broadcast({
      id: 'note-1',
      notebookId: 'nb-1',
      title: 'Hello',
      content: 'world',
      updatedAt: 1,
    });

    expect(client.conversationsCreated[0].sent.some((message) => message.includes('crdt-update'))).toBe(true);
  });

  it('applies only the newest CRDT update for a note', async () => {
    const updates: CrdtUpdatePayload[] = [];
    const client = new MockClient();
    client.enqueueIncoming([
      buildRemoteMessage({
        notebookId: 'nb-1',
        noteId: 'note-1',
        title: 'first',
        content: 'draft',
        updatedAt: 1,
        version: 1,
        author: 'peer',
      }),
      buildRemoteMessage({
        notebookId: 'nb-1',
        noteId: 'note-1',
        title: 'first',
        content: 'draft',
        updatedAt: 1,
        version: 1,
        author: 'peer',
      }),
    ]);

    const session = new NotebookCollaborationSession({
      notebookId: 'nb-1',
      client: client as unknown as XmtpClientLike,
      onRemoteUpdate: (update) => updates.push(update),
      debugLoggingEnabled: false,
    });

    await session.start([{ address: '0x1234567890123456789012345678901234567890' }], 'Team Notes');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(updates).toHaveLength(1);
    expect(updates[0].version).toBe(1);
  });
});
