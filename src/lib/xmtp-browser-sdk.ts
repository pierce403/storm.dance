import { Client as XmtpClient, type ClientOptions } from '@xmtp/browser-sdk';
import { Wallet, ethers } from 'ethers';
import { IdentityUtils } from '@/utils/identity';

export type BrowserClient = XmtpClient;

export async function createBrowserClient(
  options: { env: 'dev' | 'production' | 'local' }
): Promise<{ client: BrowserClient; wallet: ethers.Signer }> {
  const { env } = options;

  // Check for persisted key in localStorage
  const wallet = IdentityUtils.loadIdentity();

  if (wallet) {
    console.log('Restoring XMTP identity from localStorage');
  } else {
    throw new Error('No XMTP identity found. Please create a new identity.');
  }

  // Adapter to match the SDK's expected Signer interface
  const signer = {
    getAddress: async () => await wallet.getAddress(),
    signMessage: async (message: string) => await wallet.signMessage(message),
  };

  const sdkSigner = {
    type: 'EOA' as const,
    getIdentifier: async () => ({
      identifier: await signer.getAddress(),
      identifierKind: 'Ethereum' as const,
    }),
    signMessage: async (message: string) => {
      const signature = await signer.signMessage(message);
      return ethers.getBytes(signature);
    },
  };

  const client = await XmtpClient.create(sdkSigner, {
    env,
  });

  return { client, wallet };
}

export function buildNotebookTopic(notebookId: string) {
  return `stormdance:notebook:${notebookId}`;
}
