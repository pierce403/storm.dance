import { describe, it, expect } from 'vitest';
import { resolveEnsOrAddress } from './contacts';

const address = '0x1234567890abcdef1234567890abcdef12345678';
const checksum = '0x1234567890AbcdEF1234567890aBcdef12345678';

describe('resolveEnsOrAddress', () => {
  it('returns checksum address when provided a raw address', async () => {
    const contact = await resolveEnsOrAddress(address);
    expect(contact.address).toBe(checksum);
  });

  it('resolves ENS names with a custom resolver', async () => {
    const contact = await resolveEnsOrAddress('alice.eth', async () => address);
    expect(contact.address).toBe(checksum);
    expect(contact.ensName).toBe('alice.eth');
  });

  it('throws for invalid inputs', async () => {
    await expect(resolveEnsOrAddress('not-a-contact', async () => null)).rejects.toThrow();
  });
});
