import { openDB, IDBPDatabase, DBSchema } from 'idb';

// --- Interface Definitions ---

export interface Notebook {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Folder {
  id: string;
  notebookId: string;
  name: string;
  parentFolderId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  notebookId: string;
  folderId: string | null;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// --- Database Schema ---

interface StormDanceDB extends DBSchema {
  notebooks: {
    key: string;
    value: Notebook;
    indexes: { 'by-updated': number };
  };
  folders: {
    key: string;
    value: Folder;
    indexes: {
      'by-updated': number;
      'by-notebook': string;
      'by-parent-folder': string; // Index non-null parent IDs
    };
  };
  notes: {
    key: string;
    value: Note;
    indexes: {
      'by-updated': number;
      'by-notebook-updated': [string, number];
      'by-folder': string; // Index non-null folder IDs
    };
  };
}

export const DB_NAME = 'storm.dance';
const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase<StormDanceDB>> | null = null;

const initDB = (): Promise<IDBPDatabase<StormDanceDB>> => {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = openDB<StormDanceDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      console.log(`Upgrading DB from version ${oldVersion} to ${newVersion ?? DB_VERSION}`);

      // Notebooks Store
      if (!db.objectStoreNames.contains('notebooks')) {
        const notebooksStore = db.createObjectStore('notebooks', { keyPath: 'id' });
        notebooksStore.createIndex('by-updated', 'updatedAt');
      } else if (oldVersion < 5) {
        // V5: Remove aesKey property (migrating to password-based derivation for export/import)
        console.log("V5 Migration: Removing 'aesKey' from notebooks...");
        const store = tx.objectStore('notebooks');
        (async () => { // IIFE for async operation within upgrade
            let cursor = await store.openCursor();
            while(cursor) {
                const value = cursor.value as any; // Cast to any for migration
                const aesKey = value.aesKey;
                const { aesKey: _removed, ...rest } = value; // Use different name for removed key
                if (aesKey !== undefined) {
                    await cursor.update(rest);
                }
                cursor = await cursor.continue();
            }
            console.log("V5 Migration: 'aesKey' removal complete.");
        })();
      }

      // Folders Store
      if (!db.objectStoreNames.contains('folders')) {
        const foldersStore = db.createObjectStore('folders', { keyPath: 'id' });
        foldersStore.createIndex('by-updated', 'updatedAt');
        foldersStore.createIndex('by-notebook', 'notebookId');
        foldersStore.createIndex('by-parent-folder', 'parentFolderId');
      } else if (oldVersion < 3 && tx.objectStore('folders').indexNames.contains('by-parent-folder') === false) {
          tx.objectStore('folders').createIndex('by-parent-folder', 'parentFolderId');
      }

      // Notes Store
      if (!db.objectStoreNames.contains('notes')) {
        const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
        notesStore.createIndex('by-updated', 'updatedAt');
        notesStore.createIndex('by-notebook-updated', ['notebookId', 'updatedAt']);
        notesStore.createIndex('by-folder', 'folderId');
      } else {
          const notesStore = tx.objectStore('notes');
          // V2 migration
          if (oldVersion < 2 && !notesStore.indexNames.contains('by-notebook-updated')) {
              notesStore.createIndex('by-notebook-updated', ['notebookId', 'updatedAt']);
          }
          // V3 migration
          if (oldVersion < 3) {
              if (!notesStore.indexNames.contains('by-folder')) {
                  notesStore.createIndex('by-folder', 'folderId');
              }
              // Migrate data
              console.log("V3 Migration: Ensuring 'folderId' property...");
              (async () => {
                  let cursor = await notesStore.openCursor();
                  while (cursor) {
                      const value = cursor.value;
                      // Check if folderId is missing
                      if (value.folderId === undefined) {
                           await cursor.update({ ...value, folderId: null });
                      }
                      cursor = await cursor.continue();
                  }
                  console.log("V3 Migration: 'folderId' check complete.");
              })();
          }
      }
    },
    blocked() {
      console.error('IndexedDB connection blocked. Please close other tabs running this application.');
      // Optional: Display a message to the user in the UI
      alert('Database update blocked. Please close other tabs running this application and reload.');
    },
    blocking() {
      console.warn('IndexedDB connection is blocking other instances.');
      // Could potentially close the DB connection gracefully here if needed
    },
    terminated() {
      console.error('IndexedDB connection terminated unexpectedly. Reloading might be necessary.');
    }
  });
  return dbPromise;
};

// --- Service Object ---

export type CreateNotebookInput = Omit<Notebook, 'id' | 'createdAt' | 'updatedAt'>;
export type CreateFolderInput = Omit<Folder, 'id' | 'createdAt' | 'updatedAt'>;
export type CreateNoteInput = Omit<Note, 'id' | 'createdAt' | 'updatedAt'>;

// Base64 Helpers
export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
};

export const dbService = {
  getDb: initDB,

  async _ensureDefaultNotebook(): Promise<Notebook> {
    const db = await this.getDb();
    const allNotebooks = await db.getAll('notebooks'); // No key check needed now
    if (allNotebooks.length > 0) {
      return allNotebooks.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }
    return this.createNotebook({ name: 'My Notebook' });
  },

  async getAllNotebooks(): Promise<Notebook[]> {
    const db = await this.getDb();
    const notebooks = await db.getAllFromIndex('notebooks', 'by-updated').then(nbs => nbs.reverse());
    return notebooks;
  },

  // Create notebook and GENERATE a new key
  async createNotebook(notebookInput: CreateNotebookInput): Promise<Notebook> {
    const db = await this.getDb();
    const timestamp = Date.now();
    const newNotebook: Notebook = {
      id: crypto.randomUUID(),
      ...notebookInput,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await db.put('notebooks', newNotebook);
    return newNotebook;
  },

  // --- Folder operations ---
  async getAllFolders(notebookId: string): Promise<Folder[]> {
    const db = await this.getDb();
    const folders = await db.getAllFromIndex('folders', 'by-notebook', notebookId);
    // Filter for root folders (parentFolderId is null) AFTER getting from DB
    // const rootFolders = folders.filter(f => f.parentFolderId === null);
    // Or return all and let UI handle hierarchy
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  },

  async createFolder(folderInput: CreateFolderInput): Promise<Folder> {
    const db = await this.getDb();
    const timestamp = Date.now();
    const newFolder: Folder = {
      id: crypto.randomUUID(),
      ...folderInput,
      parentFolderId: folderInput.parentFolderId || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!newFolder.notebookId) throw new Error("Folder must have notebookId");
    await db.put('folders', newFolder);
    return newFolder;
  },

  async updateFolder(id: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>): Promise<Folder | undefined> {
    const db = await this.getDb();
    const folder = await db.get('folders', id);
    if (!folder) return undefined;
    const updatedFolder: Folder = { ...folder, ...updates, updatedAt: Date.now() };
    await db.put('folders', updatedFolder);
    return updatedFolder;
  },

  async deleteFolder(id: string): Promise<boolean> {
    const db = await this.getDb();
    const folderToDelete = await db.get('folders', id);
    if (!folderToDelete) return false;
    const targetParentId = folderToDelete.parentFolderId;
    const tx = db.transaction(['folders', 'notes'], 'readwrite');
    const foldersStore = tx.objectStore('folders');
    const notesStore = tx.objectStore('notes');

    // Re-parent notes
    let notesCursor = await notesStore.index('by-folder').openCursor(IDBKeyRange.only(id));
    while(notesCursor) {
      await notesCursor.update({ ...notesCursor.value, folderId: targetParentId, updatedAt: Date.now() });
      notesCursor = await notesCursor.continue();
    }
    // Re-parent subfolders
    let subfoldersCursor = await foldersStore.index('by-parent-folder').openCursor(IDBKeyRange.only(id));
    while(subfoldersCursor) {
      await subfoldersCursor.update({ ...subfoldersCursor.value, parentFolderId: targetParentId, updatedAt: Date.now() });
      subfoldersCursor = await subfoldersCursor.continue();
    }
    // Delete the folder
    await foldersStore.delete(id);
    await tx.done;
    return true;
  },

  async moveFolder(folderId: string, targetParentFolderId: string | null): Promise<Folder | undefined> {
    const db = await this.getDb();
    const folderToMove = await db.get('folders', folderId);
    if (!folderToMove) return undefined;
    const targetId = targetParentFolderId || null;
    if (folderId === targetId) return folderToMove;

    // Check for cyclical move
    let currentParentId = targetId;
    while (currentParentId !== null) {
      if (currentParentId === folderId) return folderToMove;
      const parentFolder = await db.get('folders', currentParentId);
      if (!parentFolder) break;
      currentParentId = parentFolder.parentFolderId;
    }

    if (folderToMove.parentFolderId !== targetId) {
      const updatedFolder: Folder = { ...folderToMove, parentFolderId: targetId, updatedAt: Date.now() };
      await db.put('folders', updatedFolder);
      return updatedFolder;
    }
    return folderToMove;
  },

  // --- Note operations ---
  async getAllNotes(notebookId: string): Promise<Note[]> {
    const db = await this.getDb();
    const index = db.transaction('notes').objectStore('notes').index('by-notebook-updated');
    const range = IDBKeyRange.bound([notebookId, -Infinity], [notebookId, Infinity]);
    return index.getAll(range).then(notes => notes.reverse());
  },

  async createNote(noteInput: CreateNoteInput): Promise<Note> {
    const db = await this.getDb();
    const timestamp = Date.now();
    const newNote: Note = { id: crypto.randomUUID(), ...noteInput, folderId: noteInput.folderId ?? null, createdAt: timestamp, updatedAt: timestamp };
    if (!newNote.notebookId) throw new Error("Note must have notebookId");
    await db.put('notes', newNote);
    return newNote;
  },

  async updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>): Promise<Note | undefined> {
    const db = await this.getDb();
    const note = await db.get('notes', id);
    if (!note) return undefined;
    const updatedNote: Note = { ...note, ...updates, updatedAt: Date.now() };
    await db.put('notes', updatedNote);
    return updatedNote;
  },

  async upsertExternalNote(note: Note): Promise<Note> {
    const db = await this.getDb();
    await db.put('notes', note);
    return note;
  },

  async deleteNote(id: string): Promise<boolean> {
    const db = await this.getDb();
    await db.delete('notes', id);
    return true;
  },

  async moveNoteToFolder(noteId: string, folderId: string | null): Promise<Note | undefined> {
    const targetFolderId = folderId || null;
    return this.updateNote(noteId, { folderId: targetFolderId });
  },

  async deleteNotebook(notebookId: string): Promise<boolean> {
    const db = await this.getDb();
    const notebook = await db.get('notebooks', notebookId);
    if (!notebook) return false;

    // Use a transaction to delete notebook, folders, and notes atomically
    const tx = db.transaction(['notebooks', 'folders', 'notes'], 'readwrite');
    const notesStore = tx.objectStore('notes');
    const foldersStore = tx.objectStore('folders');
    const notebooksStore = tx.objectStore('notebooks');

    // 1. Delete all notes associated with the notebook
    let notesCursor = await notesStore.index('by-notebook-updated').openCursor(IDBKeyRange.bound([notebookId, -Infinity], [notebookId, Infinity]));
    while(notesCursor) {
      await notesCursor.delete();
      notesCursor = await notesCursor.continue();
    }

    // 2. Delete all folders associated with the notebook
    let foldersCursor = await foldersStore.index('by-notebook').openCursor(IDBKeyRange.only(notebookId));
    while(foldersCursor) {
      await foldersCursor.delete();
      foldersCursor = await foldersCursor.continue();
    }

    // 3. Delete the notebook itself
    await notebooksStore.delete(notebookId);

    await tx.done;
    console.log(`Notebook ${notebookId} and all its contents deleted.`);
    return true;
  },
};
