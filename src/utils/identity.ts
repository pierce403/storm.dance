import { Wallet, HDNodeWallet } from 'ethers';

const STORAGE_KEY = 'XMTP_IDENTITY_KEY';

export const IdentityUtils = {
    /**
     * Creates a new random Ethereum wallet.
     */
    createRandomIdentity: (): HDNodeWallet => {
        return Wallet.createRandom();
    },

    /**
     * Saves the private key to local storage.
     * @param privateKey The private key to save.
     */
    saveIdentity: (privateKey: string) => {
        localStorage.setItem(STORAGE_KEY, privateKey);
    },

    /**
     * Loads the identity (Wallet) from local storage if it exists.
     */
    loadIdentity: (): Wallet | null => {
        const privateKey = localStorage.getItem(STORAGE_KEY);
        if (!privateKey) return null;
        try {
            return new Wallet(privateKey);
        } catch (error) {
            console.error('Failed to load identity from storage:', error);
            return null;
        }
    },

    /**
     * Checks if an identity exists in local storage.
     */
    hasIdentity: (): boolean => {
        return !!localStorage.getItem(STORAGE_KEY);
    },

    /**
     * Removes the identity from local storage.
     */
    clearIdentity: () => {
        localStorage.removeItem(STORAGE_KEY);
    }
};
