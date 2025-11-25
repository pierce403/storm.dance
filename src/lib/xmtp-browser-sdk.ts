import { Client, type Conversation, type DecodedMessage } from '@xmtp/xmtp-js';
import { Wallet } from 'ethers';

export type BrowserClient = Client;
export type BrowserConversation = Conversation;
export type BrowserMessage = DecodedMessage;

export interface BrowserClientOptions {
  env?: 'dev' | 'production';
  privateKey?: string;
}

export async function createBrowserClient(options: BrowserClientOptions = {}) {
  const env = options.env ?? 'dev';
  const wallet = options.privateKey ? new Wallet(options.privateKey) : Wallet.createRandom();
  const client = await Client.create(wallet, {
    env,
    persistConversations: true,
    skipContactPublishing: false,
    // @ts-expect-error enableV3 is not yet in the types but required for v3
    enableV3: true,
  });

  return { client, wallet };
}

export function buildNotebookTopic(notebookId: string) {
  return `stormdance:notebook:${notebookId}`;
}
