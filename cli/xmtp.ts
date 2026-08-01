import {
  Client,
  ConsentState,
  Group,
  IdentifierKind,
  SortDirection,
  type DecodedMessage,
  type Signer,
} from '@xmtp/node-sdk';
import { getBytes } from 'ethers';
import {
  getOrCreateXmtpDbEncryptionKey,
  getProfilePaths,
  loadIdentity,
  type IdentityOptions,
  type IdentityWallet,
  type StormdanceXmtpEnvironment,
} from './auth.js';

export interface CreateNodeXmtpClientOptions extends IdentityOptions {
  env?: StormdanceXmtpEnvironment;
  appVersion?: string;
}

export interface XmtpGroupMessage {
  id: string;
  conversationId: string;
  senderInboxId: string;
  sentAt: Date;
  kind: number;
  content: unknown;
}

export interface XmtpGroupStreamOptions {
  onMessage: (message: XmtpGroupMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
  onFail?: () => void;
  onRestart?: () => void;
}

export interface XmtpListMessagesOptions {
  direction?: 'ascending' | 'descending';
  limit?: number;
}

export interface XmtpGroupStream {
  readonly isDone: boolean;
  end(): Promise<void>;
}

export interface XmtpGroupAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  allow(): void;
  sync(): Promise<void>;
  messages(options?: XmtpListMessagesOptions): Promise<XmtpGroupMessage[]>;
  sendText(text: string, idempotencyKey?: string): Promise<string>;
  stream(options: XmtpGroupStreamOptions): Promise<XmtpGroupStream>;
}

/** Adapt an unlocked ethers wallet to the signer contract used by XMTP. */
export function createXmtpSigner(wallet: IdentityWallet): Signer {
  return {
    type: 'EOA',
    getIdentifier: async () => ({
      identifier: await wallet.getAddress(),
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message: string) => getBytes(await wallet.signMessage(message)),
  };
}

/**
 * Open or register the profile's XMTP installation. The same profile always
 * reuses its encrypted SQLite path and 32-byte database key.
 */
export async function createNodeXmtpClient(
  options: CreateNodeXmtpClientOptions = {},
): Promise<Client> {
  const env = options.env ?? 'production';
  const pathOptions = {
    profile: options.profile,
    env,
    environment: options.environment,
  };
  const paths = getProfilePaths(pathOptions);
  const [wallet, dbEncryptionKey] = await Promise.all([
    loadIdentity({ ...pathOptions, password: options.password }),
    getOrCreateXmtpDbEncryptionKey(pathOptions),
  ]);

  return Client.create(createXmtpSigner(wallet), {
    env,
    appVersion: options.appVersion ?? 'stormdance-cli/0.1',
    dbPath: paths.xmtpDatabase,
    dbEncryptionKey,
  });
}

function adaptMessage(message: DecodedMessage): XmtpGroupMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderInboxId: message.senderInboxId,
    sentAt: message.sentAt,
    kind: Number(message.kind),
    content: message.content,
  };
}

class NodeXmtpGroupAdapter implements XmtpGroupAdapter {
  readonly #group: Group;

  constructor(group: Group) {
    this.#group = group;
  }

  get id(): string {
    return this.#group.id;
  }

  get name(): string {
    return this.#group.name;
  }

  get description(): string {
    return this.#group.description;
  }

  allow(): void {
    if (this.#group.consentState() !== ConsentState.Allowed) {
      this.#group.updateConsentState(ConsentState.Allowed);
    }
  }

  async sync(): Promise<void> {
    await this.#group.sync();
  }

  async messages(options?: XmtpListMessagesOptions): Promise<XmtpGroupMessage[]> {
    const messages = await this.#group.messages(options ? {
      limit: options.limit,
      direction: options.direction === 'descending'
        ? SortDirection.Descending
        : SortDirection.Ascending,
    } : undefined);
    return messages.map(adaptMessage);
  }

  sendText(text: string, idempotencyKey?: string): Promise<string> {
    return this.#group.sendText(
      text,
      idempotencyKey === undefined ? undefined : { idempotencyKey },
    );
  }

  async stream(options: XmtpGroupStreamOptions): Promise<XmtpGroupStream> {
    const stream = await this.#group.stream({
      onValue: (message) => {
        void Promise.resolve(options.onMessage(adaptMessage(message))).catch((error: unknown) => {
          options.onError?.(
            error instanceof Error ? error : new Error('XMTP group message handler failed.'),
          );
        });
      },
      onError: options.onError,
      onFail: options.onFail,
      onRestart: options.onRestart,
    });

    return {
      get isDone() {
        return stream.isDone;
      },
      async end() {
        await stream.end();
      },
    };
  }
}

export function adaptXmtpGroup(group: Group): XmtpGroupAdapter {
  return new NodeXmtpGroupAdapter(group);
}

/** Pull group welcomes and messages from XMTP into the client's local DB. */
export async function syncGroups(client: Client): Promise<void> {
  await client.conversations.syncAll([
    ConsentState.Allowed,
    ConsentState.Unknown,
  ]);
}

/** List local groups, synchronizing first unless explicitly disabled. */
export async function listGroups(
  client: Client,
  options: { sync?: boolean } = {},
): Promise<XmtpGroupAdapter[]> {
  if (options.sync !== false) {
    await syncGroups(client);
  }
  return client.conversations.listGroups().map(adaptXmtpGroup);
}

/** Resolve a group by conversation ID and synchronize its current state. */
export async function getGroup(
  client: Client,
  conversationId: string,
  options: { sync?: boolean } = {},
): Promise<XmtpGroupAdapter | undefined> {
  if (options.sync !== false) {
    await client.conversations.sync();
  }
  const conversation = await client.conversations.getConversationById(conversationId);
  if (!(conversation instanceof Group)) {
    return undefined;
  }
  if (conversation.consentState() !== ConsentState.Allowed) {
    conversation.updateConsentState(ConsentState.Allowed);
  }
  if (options.sync !== false) {
    await conversation.sync();
  }
  return adaptXmtpGroup(conversation);
}
