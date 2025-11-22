import type { BrowserConversation, BrowserMessage } from '@xmtp/browser-sdk';
import { buildNotebookTopic } from '@xmtp/browser-sdk';
import { NotebookCrdtClock, buildUpdatePayload } from './crdt';
import { CollaborationContact, CrdtUpdatePayload } from './types';

export interface NoteShape {
  id: string;
  notebookId: string;
  title: string;
  content: string;
  updatedAt: number;
}

interface ConversationFactory {
  newConversation: (address: string, context?: any, consentProof?: any) => Promise<BrowserConversation>;
}

export interface XmtpClientLike {
  address: string;
  canMessage: (address: string) => Promise<boolean>;
  conversations: ConversationFactory;
}

export type RemoteUpdateHandler = (update: CrdtUpdatePayload) => Promise<void> | void;

export class NotebookCollaborationSession {
  private readonly client: XmtpClientLike;
  private readonly notebookId: string;
  private readonly onRemoteUpdate: RemoteUpdateHandler;
  private readonly clock = new NotebookCrdtClock();
  private conversations: Map<string, BrowserConversation> = new Map();
  private running = false;
  private streamAbort = false;
  private sessionToken = 0;
  readonly topic: string;

  constructor(params: { notebookId: string; client: XmtpClientLike; onRemoteUpdate: RemoteUpdateHandler }) {
    this.client = params.client;
    this.notebookId = params.notebookId;
    this.onRemoteUpdate = params.onRemoteUpdate;
    this.topic = buildNotebookTopic(params.notebookId);
  }

  async start(contacts: CollaborationContact[]) {
    this.running = true;
    this.streamAbort = false;
    this.sessionToken += 1;
    const token = this.sessionToken;
    const validContacts = await this.filterContacts(contacts);
    const created = await Promise.all(
      validContacts.map(async (contact) => {
        const conversation = await this.client.conversations.newConversation(contact.address, {
          conversationId: this.topic,
          metadata: { notebookId: this.notebookId },
        });
        this.startStream(conversation, token);
        return [contact.address, conversation] as const;
      })
    );
    this.conversations = new Map(created);
  }

  async stop() {
    this.running = false;
    this.streamAbort = true;
    this.sessionToken += 1;
    this.conversations.clear();
  }

  async broadcast(note: NoteShape) {
    if (!this.running || note.notebookId !== this.notebookId) return;
    const version = this.clock.nextVersion(note.id);
    const payload = buildUpdatePayload({
      notebookId: this.notebookId,
      noteId: note.id,
      title: note.title,
      content: note.content,
      updatedAt: note.updatedAt,
      version,
      author: this.client.address,
    });

    const serialized = JSON.stringify({ type: 'crdt-update', payload });
    await Promise.all(Array.from(this.conversations.values()).map((conversation) => conversation.send(serialized)));
  }

  private async filterContacts(contacts: CollaborationContact[]) {
    const results: CollaborationContact[] = [];
    for (const contact of contacts) {
      const canReach = await this.client.canMessage(contact.address);
      if (canReach) {
        results.push(contact);
      }
    }
    return results;
  }

  private async startStream(conversation: BrowserConversation, token: number) {
    const stream = await conversation.streamMessages();
    const selfAddress = this.client.address.toLowerCase();
    (async () => {
      for await (const message of stream as AsyncIterable<BrowserMessage>) {
        if (this.streamAbort || token !== this.sessionToken) {
          break;
        }
        if (message.senderAddress.toLowerCase() === selfAddress) continue;
        this.processMessage(message);
      }
    })();
  }

  private async processMessage(message: BrowserMessage) {
    try {
      const raw = typeof message.content === 'string' ? message.content : String(message.content);
      const parsed = JSON.parse(raw);
      if (parsed?.type !== 'crdt-update' || !parsed.payload) return;
      const payload: CrdtUpdatePayload = parsed.payload;
      if (payload.notebookId !== this.notebookId) return;
      if (!this.clock.shouldApply(payload)) return;
      this.clock.record(payload);
      await this.onRemoteUpdate(payload);
    } catch (err) {
      console.warn('Failed to process XMTP message', err);
    }
  }
}
