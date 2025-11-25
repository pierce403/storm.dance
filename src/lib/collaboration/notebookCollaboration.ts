import type { Conversation, DecodedMessage, Identifier } from '@xmtp/browser-sdk';
import { buildNotebookTopic } from '../xmtp-browser-sdk';
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
  newDmWithIdentifier: (identifier: Identifier, options?: any) => Promise<Conversation>;
}

export interface XmtpClientLike {
  inboxId: string | undefined;
  canMessage: (identifiers: Identifier[]) => Promise<Map<string, boolean>>;
  conversations: ConversationFactory;
}

export type RemoteUpdateHandler = (update: CrdtUpdatePayload) => Promise<void> | void;

export class NotebookCollaborationSession {
  private readonly client: XmtpClientLike;
  private readonly notebookId: string;
  private readonly onRemoteUpdate: RemoteUpdateHandler;
  private readonly clock = new NotebookCrdtClock();
  private conversations: Map<string, Conversation> = new Map();
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
        const identifier: Identifier = { identifierKind: 'Ethereum' as const, identifier: contact.address };
        // Note: v5 newDmWithIdentifier options might not support conversationId or metadata directly in the same way?
        // Checking index.d.ts: newDmWithIdentifier(identifier: Identifier, options?: SafeCreateDmOptions)
        // SafeCreateDmOptions = { messageDisappearingSettings?: ... }
        // It seems custom metadata or conversationId (topic) might not be supported for DMs in v5 the same way?
        // DMs are deterministic by participants.
        // If we need a specific topic, we might need to use Groups or just use the default DM and filter messages by content/metadata?
        // But the previous code used `conversationId: this.topic`.
        // If we can't set conversationId, we can't separate notebook sessions easily?
        // Wait, XMTP v3 DMs are just DMs.
        // Maybe we should filter messages by `notebookId` in the payload?
        // The payload already has `notebookId`.
        // So we can just use the DM.

        const conversation = await this.client.conversations.newDmWithIdentifier(identifier);
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
      author: this.client.inboxId,
    });

    const serialized = JSON.stringify({ type: 'crdt-update', payload });
    await Promise.all(Array.from(this.conversations.values()).map((conversation) => conversation.send(serialized)));
  }

  private async filterContacts(contacts: CollaborationContact[]) {
    if (contacts.length === 0) return [];

    try {
      const identifiers: Identifier[] = contacts.map(c => ({
        identifierKind: 'Ethereum' as const,
        identifier: c.address
      }));

      const canMessageMap = await this.client.canMessage(identifiers);

      return contacts.filter(c => {
        // canMessageMap keys are string representation of identifier? or just the identifier string?
        // Usually it's the address string for Ethereum identifiers.
        return canMessageMap.get(c.address) ?? false;
      });
    } catch (e) {
      console.warn("Error checking canMessage", e);
      return contacts;
    }
  }

  private async startStream(conversation: Conversation, token: number) {
    const selfInboxId = this.client.inboxId;

    // v5 stream() takes a callback
    // Cast conversation to any to avoid type mismatch if Conversation type is from wasm-bindings
    await (conversation as any).stream((error: Error | null, message: DecodedMessage | undefined) => {
      if (this.streamAbort || token !== this.sessionToken) {
        // How to stop stream? The stream method returns a StreamCloser (function)
        // But here we are awaiting it? No, stream() returns Promise<StreamCloser>
        return;
      }
      if (error || !message) return;

      if (message.senderInboxId === selfInboxId) return;
      this.processMessage(message);
    }, () => {
      // onFail
      console.log("Stream failed");
    });
  }

  private async processMessage(message: DecodedMessage) {
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
