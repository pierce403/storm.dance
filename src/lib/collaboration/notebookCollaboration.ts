import type { Conversation, DecodedMessage, Identifier } from '@xmtp/browser-sdk';
import { buildNotebookTopic } from '../xmtp-browser-sdk';
import { NotebookCrdtClock, buildUpdatePayload } from './crdt';
import { CollaborationContact, CrdtUpdatePayload, InvitePayload, CollaborationMessage } from './types';

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
  address: string | undefined; // Add address
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
  private readonly debugLoggingEnabled: boolean;

  constructor(params: { notebookId: string; client: XmtpClientLike; onRemoteUpdate: RemoteUpdateHandler; debugLoggingEnabled: boolean }) {
    this.client = params.client;
    this.notebookId = params.notebookId;
    this.onRemoteUpdate = params.onRemoteUpdate;
    this.topic = buildNotebookTopic(params.notebookId);
    this.debugLoggingEnabled = params.debugLoggingEnabled;
  }

  async start(contacts: CollaborationContact[], notebookName: string) {
    this.running = true;
    this.streamAbort = false;
    this.sessionToken += 1;
    const token = this.sessionToken;
    const validContacts = await this.filterContacts(contacts);
    const created = await Promise.all(
      validContacts.map(async (contact) => {
        const identifier: Identifier = { identifierKind: 'Ethereum' as const, identifier: contact.address };
        const conversation = await this.client.conversations.newDmWithIdentifier(identifier);

        // Send invite
        const invitePayload: InvitePayload = {
          notebookId: this.notebookId,
          notebookName: notebookName,
          inviterName: 'User', // TODO: Get actual user name if available
          inviterAddress: this.client.address || '', // Fallback or ensure address is available
        };
        const inviteMsg: CollaborationMessage = { type: 'invite', payload: invitePayload };
        const serializedInvite = JSON.stringify(inviteMsg);
        if (this.debugLoggingEnabled) {
          console.log(`[XMTP Outgoing] Conversation: ${(conversation as any).topic}`, serializedInvite);
        }
        await conversation.send(serializedInvite);

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
    await Promise.all(Array.from(this.conversations.values()).map((conversation) => {
      if (this.debugLoggingEnabled) {
        console.log(`[XMTP Outgoing] Conversation: ${(conversation as any).topic}`, serialized);
      }
      return conversation.send(serialized);
    }));
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
        return canMessageMap.get(c.address) ?? false;
      });
    } catch (e) {
      console.warn("Error checking canMessage", e);
      return contacts;
    }
  }

  private async startStream(conversation: Conversation, token: number) {
    const selfInboxId = this.client.inboxId;

    // Cast conversation to any to avoid type mismatch if Conversation type is from wasm-bindings
    await (conversation as any).stream((error: Error | null, message: DecodedMessage | undefined) => {
      if (this.streamAbort || token !== this.sessionToken) {
        return;
      }
      if (error || !message) return;

      if (message.senderInboxId === selfInboxId) return;

      if (this.debugLoggingEnabled) {
        const raw = typeof message.content === 'string' ? message.content : String(message.content);
        console.log(`[XMTP Incoming] Conversation: ${(conversation as any).topic}`, raw);
      }

      this.processMessage(message);
    }, () => {
      console.log("Stream failed");
    });
  }

  private async processMessage(message: DecodedMessage) {
    try {
      const raw = typeof message.content === 'string' ? message.content : String(message.content);
      const parsed = JSON.parse(raw) as CollaborationMessage;

      if (parsed.type === 'invite') {
        // Ignore invites in the active session processor
        return;
      }

      if (parsed.type === 'crdt-update') {
        const payload = parsed.payload;
        if (payload.notebookId !== this.notebookId) return;
        if (!this.clock.shouldApply(payload)) return;
        this.clock.record(payload);
        await this.onRemoteUpdate(payload);
      }
    } catch (err) {
      console.warn('Failed to process XMTP message', err);
    }
  }
}
