import { ethers } from 'ethers';
import { CollaborationContact } from './types';

export type EnsResolver = (name: string) => Promise<string | null>;

export async function resolveEnsOrAddress(
  value: string,
  resolver?: EnsResolver
): Promise<CollaborationContact> {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('Contact cannot be empty');
  }

  if (ethers.isAddress(normalized)) {
    return { address: ethers.getAddress(normalized) };
  }

  if (/\.eth$/i.test(normalized)) {
    const provider = resolver || defaultEnsResolver;
    const resolved = await provider(normalized);
    if (!resolved) {
      throw new Error(`Could not resolve ${normalized}`);
    }
    return { address: ethers.getAddress(resolved), ensName: normalized };
  }

  throw new Error('Enter a valid ENS name or wallet address');
}

const defaultEnsResolver: EnsResolver = async (name: string) => {
  try {
    const provider = new ethers.JsonRpcProvider('https://cloudflare-eth.com');
    return await provider.resolveName(name);
  } catch (err) {
    console.warn('ENS resolution failed', err);
    return null;
  }
};
