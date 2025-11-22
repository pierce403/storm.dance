import { describe, it, expect } from 'vitest';
import { NotebookCollaborationSession } from './notebookCollaboration';
import type { CrdtUpdatePayload } from './types';

interface MockMessage {
  senderAddress: string;
  content: any;
}

class MockConversation {
  sent: string[] = [];
  constructor(public peerAddress: string, private incoming: MockMessage[] = []) {}

  async send(content: any) {
    this.sent.push(typeof content === 'string' ? content : JSON.stringify(content));
  }

  async *streamMessages() {
    for (const message of this.incoming) {
      yield message as any;
    }
  }
}

class MockClient {
  address = '0x0011223344556677889900112233445566778899';
  conversationsCreated: MockConversation[] = [];
  incomingQueues: MockMessage[][] = [];

  canMessage = async () => true;

  enqueueIncoming(messages: MockMessage[]) {
    this.incomingQueues.push(messages);
  }

  conversations = {
    newConversation: async (address: string) => {
      const messages = this.incomingQueues.shift() || [];
      const conversation = new MockConversation(address, messages);
      this.conversationsCreated.push(conversation);
      return conversation as any;
    },
  };
}

const buildRemoteMessage = (payload: CrdtUpdatePayload): MockMessage => ({
  senderAddress: '0xaabbccddeeff0011223344556677889900aabbcc',
  content: JSON.stringify({ type: 'crdt-update', payload }),
});

describe('NotebookCollaborationSession', () => {
  it('broadcasts CRDT updates to every collaborator', async () => {
    const client = new MockClient();
    const session = new NotebookCollaborationSession({
      notebookId: 'nb-1',
      client: client as any,
      onRemoteUpdate: () => {},
    });

    await session.start([{ address: '0x1234567890123456789012345678901234567890' }]);
    await session.broadcast({
      id: 'note-1',
      notebookId: 'nb-1',
      title: 'Hello',
      content: 'world',
      updatedAt: 1,
    });

    expect(client.conversationsCreated[0].sent[0]).toContain('crdt-update');
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
      client: client as any,
      onRemoteUpdate: (update) => updates.push(update),
    });

    await session.start([{ address: '0x1234567890123456789012345678901234567890' }]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(updates).toHaveLength(1);
    expect(updates[0].version).toBe(1);
  });
});
