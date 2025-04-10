import { base64ToArrayBuffer, arrayBufferToBase64 } from './db';
import pako from 'pako';

const KDF_ITERATIONS = 250000; // Number of PBKDF2 iterations
const KDF_HASH = 'SHA-256';

// --- Password-Based Encryption --- 

/**
 * Derives an AES-GCM key from a password and salt using PBKDF2.
 */
const deriveKey = async (password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> => {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    const baseKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: iterations, hash: KDF_HASH },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        true, // Allow export for debugging if needed, but generally false for security
        ['encrypt', 'decrypt']
    );
};

/**
 * Compresses, encrypts data using password-derived key, and packages into a wrapper JSON.
 * @param password The user's password.
 * @param data The data object to encrypt.
 * @returns A Promise resolving to the wrapper JSON object.
 */
export const encryptBackup = async (password: string, data: any): Promise<object> => {
    try {
        // 1. Stringify and Compress
        const jsonString = JSON.stringify(data);
        const compressedBytes = pako.deflate(jsonString);

        // 2. Generate Salt and IV
        const salt = crypto.getRandomValues(new Uint8Array(16)); // 16-byte salt
        const iv = crypto.getRandomValues(new Uint8Array(12));   // 12-byte IV for AES-GCM

        // 3. Derive Key
        const key = await deriveKey(password, salt, KDF_ITERATIONS);

        // 4. Encrypt Compressed Data
        const ciphertextBuffer = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            compressedBytes
        );

        // 5. Package Wrapper
        const wrapper = {
            wrapperVersion: 1,
            encryption: {
                iv: arrayBufferToBase64(iv.buffer),
                kdf: {
                    type: 'PBKDF2',
                    salt: arrayBufferToBase64(salt.buffer),
                    iterations: KDF_ITERATIONS,
                    hash: KDF_HASH
                }
            },
            ciphertext: arrayBufferToBase64(ciphertextBuffer)
        };

        return wrapper;

    } catch (error) {
        console.error("Backup encryption failed:", error);
        throw new Error(`Encryption failed: ${error instanceof Error ? error.message : String(error)}`);
    }
};

// --- Decryption --- 

/**
 * Decrypts data from the wrapper JSON using a password.
 * @param password The user's password.
 * @param wrapper The parsed wrapper JSON object.
 * @returns A Promise resolving to the original decrypted and parsed data object.
 */
export const decryptBackup = async (password: string, wrapper: any): Promise<any> => {
    try {
        // 1. Validate Wrapper Structure (basic)
        if (!wrapper || wrapper.wrapperVersion !== 1 || !wrapper.encryption || 
            !wrapper.encryption.iv || !wrapper.encryption.kdf || 
            !wrapper.encryption.kdf.salt || !wrapper.encryption.kdf.iterations ||
            !wrapper.encryption.kdf.hash || !wrapper.ciphertext) {
            throw new Error("Invalid or unsupported backup file format.");
        }

        // 2. Decode Fields
        const iv = base64ToArrayBuffer(wrapper.encryption.iv);
        const salt = base64ToArrayBuffer(wrapper.encryption.kdf.salt);
        const iterations = wrapper.encryption.kdf.iterations;
        const ciphertext = base64ToArrayBuffer(wrapper.ciphertext);

        // 3. Derive Key
        const key = await deriveKey(password, new Uint8Array(salt), iterations);

        // 4. Decrypt
        const decryptedCompressedBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            ciphertext
        );

        // 5. Decompress
        const jsonString = pako.inflate(new Uint8Array(decryptedCompressedBuffer), { to: 'string' });

        // 6. Parse JSON
        return JSON.parse(jsonString);

    } catch (error) {
        console.error("Backup decryption failed:", error);
        // Provide more specific feedback if possible (often decryption errors are generic)
        if (error instanceof DOMException && error.name === 'OperationError') {
            throw new Error("Decryption failed. Likely incorrect password or corrupted data.");
        } else {
            throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}; 