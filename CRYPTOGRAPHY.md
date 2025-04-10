# Cryptography Specification: Compressed & Encrypted JSON Backup

This document outlines the cryptographic methods used for exporting and importing notebooks in the storm.dance application, focusing on password-based encryption and compression.

## Goals

-   **Confidentiality:** Ensure exported data is unreadable without the correct password.
-   **Integrity & Authenticity:** Ensure exported data hasn't been tampered with and originates from a valid encryption process.
-   **Compression:** Reduce the size of the backup file.
-   **Usability:** Rely on a user-provided password instead of requiring users to manage raw keys.
-   **Security:** Use strong key derivation (PBKDF2) and standard encryption (AES-GCM).

## Internal Data Structure

The notebook data is structured as a hierarchical JSON object before processing:

```json
// Simplified example - Actual structure may vary slightly
{
  "version": 1,
  "root": {
    "type": "folder",
    "name": "Notebook Root",
    "children": {
      "My Note": {
        "type": "note",
        "content": "This is the note content.",
        "createdAt": 1678886400000,
        "updatedAt": 1678886400000
      },
      "Subfolder": {
        "type": "folder",
        "children": {
            "Nested Note": { 
                "type": "note", 
                "content": "...",
                "createdAt": 1678886400000,
                "updatedAt": 1678886400000
            }
        }
      }
    }
  }
}
```

## Backup Workflow

1.  **Build JSON:** Construct the internal hierarchical JSON object representing the notebook.
2.  **Stringify:** Convert the JSON object to a string using `JSON.stringify()`.
3.  **Compress:** Compress the JSON string using `pako.deflate()` to get `compressedBytes` (Uint8Array).
4.  **Generate Salt:** Create a unique, cryptographically random 16-byte salt using `crypto.getRandomValues()`.
5.  **Derive Key:** Derive a 256-bit AES-GCM encryption key from the user-provided password and the generated salt using PBKDF2:
    -   **Hash:** SHA-256
    -   **Iterations:** >= 100,000 (e.g., 250,000)
    -   The derived key is used immediately for encryption and then discarded (not stored).
6.  **Generate IV:** Create a unique, cryptographically random 12-byte (96-bit) Initialization Vector (IV) using `crypto.getRandomValues()`.
7.  **Encrypt:** Encrypt the `compressedBytes` using the derived key and the generated IV with AES-GCM (Web Crypto API `crypto.subtle.encrypt`).
8.  **Package Wrapper:** Create a final JSON object (the "wrapper") containing:
    -   `wrapperVersion`: Version number for the wrapper format itself.
    -   `encryption`: An object containing:
        -   `iv`: The generated IV, Base64 encoded.
        -   `kdf`: Key Derivation Function details:
            -   `salt`: The generated salt, Base64 encoded.
            -   `iterations`: The number of PBKDF2 iterations used.
            -   `hash`: The hash function used (e.g., "SHA-256").
    -   `ciphertext`: The encrypted data (result of step 7), Base64 encoded.
9.  **Download:** Trigger the download of the wrapper JSON, stringified, typically with a `.json.encrypted` or similar extension (e.g., `NOTEBOOK_NAME-backup.json.encrypted`).

**Example Wrapper JSON Structure:**

```json
{
  "wrapperVersion": 1,
  "encryption": {
    "iv": "Base64==",
    "kdf": {
      "type": "PBKDF2",
      "salt": "Base64Salt==",
      "iterations": 250000,
      "hash": "SHA-256"
    }
  },
  "ciphertext": "Base64EncryptedData=="
}
```

## Restore Workflow

1.  **Select File:** User selects the `.json.encrypted` backup file.
2.  **Parse Wrapper:** Read the file and parse the wrapper JSON object.
3.  **Validate Wrapper:** Check `wrapperVersion` and the presence of required fields (`encryption.iv`, `encryption.kdf.salt`, etc.).
4.  **Decode Fields:** Base64-decode the `iv`, `salt`, and `ciphertext`.
5.  **Get Password:** Prompt the user securely for the password associated with this backup.
6.  **Derive Key:** Re-derive the AES-GCM key using the user's password, the decoded salt, and the KDF parameters stored in the wrapper (`iterations`, `hash`).
7.  **Decrypt:** Decrypt the decoded ciphertext using the derived key and the decoded IV (Web Crypto API `crypto.subtle.decrypt`). Handle potential decryption errors (wrong password, corrupted data).
8.  **Decompress:** Decompress the resulting `decryptedBytes` using `pako.inflate()` to get the original JSON string.
9.  **Parse JSON:** Parse the JSON string into a JavaScript object using `JSON.parse()`.
10. **CRITICAL - Validate & Sanitize:**
    -   Rigorously validate the structure of the parsed data object (check versions, types, expected fields).
    -   Sanitize any content intended for rendering (e.g., note content) using a library like DOMPurify to prevent XSS attacks if the content might be HTML.
11. **Import Data:** Process the validated and sanitized data object to recreate the notebook structure (folders, notes) within the application's database, generating new internal IDs.

## Technology Stack

-   **JSON:** Standard data interchange.
-   **Pako:** Zlib/Deflate compression (`pako.deflate`, `pako.inflate`).
-   **Web Crypto API:**
    -   `crypto.getRandomValues()`: For salts and IVs.
    -   `crypto.subtle.importKey`, `crypto.subtle.deriveKey`: For PBKDF2.
    -   `crypto.subtle.encrypt`, `crypto.subtle.decrypt`: For AES-GCM.
-   **Base64:** Encoding for binary data within the JSON wrapper.
-   **(Recommended) DOMPurify:** For sanitizing restored content. 