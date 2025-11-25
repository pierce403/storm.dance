import { Client as XmtpClient, type ClientOptions } from '@xmtp/browser-sdk';
import { Wallet, ethers } from 'ethers';

export type BrowserClient = XmtpClient;

export async function createBrowserClient(
  options: { env: 'dev' | 'production' | 'local' }
): Promise<{ client: BrowserClient; wallet: ethers.Signer }> {
  const { env } = options;

  // Create a random wallet for testing/demo purposes
  // In a real app, you would use a wallet connected via Wagmi or similar
  const wallet = Wallet.createRandom();
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
