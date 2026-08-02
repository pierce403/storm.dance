import { openDB, IDBPDatabase, DBSchema } from 'idb';
import { normalizeConversationId } from '@/lib/collaboration/bindings';

// --- Interface Definitions ---

export interface Notebook {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  xmtpTopic?: string;
  xmtpEnv?: 'dev' | 'production';
  xmtpBindings?: Partial<Record<'dev' | 'production', string>>;
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

export type CollaborationEnvironment = 'dev' | 'production';

export interface CollaborationState {
  notebookId: string;
  state: ArrayBuffer;
  conversationId: string | null;
  env: CollaborationEnvironment;
  updatedAt: number;
}

interface LegacyCollaborationState extends Omit<CollaborationState, 'env'> {
  env?: CollaborationEnvironment | null;
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
  collaborationStates: {
    key: string;
    value: LegacyCollaborationState;
  };
  collaborationStatesByEnv: {
    key: [string, CollaborationEnvironment];
    value: CollaborationState;
    indexes: { 'by-notebook': string };
  };
}

export const DB_NAME = 'storm.dance';
const DB_VERSION = 7;

let dbPromise: Promise<IDBPDatabase<StormDanceDB>> | null = null;
let ensureDefaultNotebookPromise: Promise<Notebook> | null = null;

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
      } else if (oldVersion < 7) {
        // V5 removed aesKey. V7 removes the synthetic pre-MLS topic values so
        // they cannot be mistaken for real group conversation IDs.
        const store = tx.objectStore('notebooks');
        void (async () => {
          let cursor = await store.openCursor();
          while (cursor) {
            const value = cursor.value as Notebook & { aesKey?: unknown };
            const next = { ...value };
            let changed = false;
            if (oldVersion < 5 && next.aesKey !== undefined) {
              delete next.aesKey;
              changed = true;
            }

            const normalizedTopic = normalizeConversationId(next.xmtpTopic);
            if (normalizedTopic !== (next.xmtpTopic ?? null)) {
              if (normalizedTopic) next.xmtpTopic = normalizedTopic;
              else delete next.xmtpTopic;
              changed = true;
            }

            if (next.xmtpBindings) {
              const normalizedBindings: Notebook['xmtpBindings'] = {};
              for (const env of ['dev', 'production'] as const) {
                const normalized = normalizeConversationId(next.xmtpBindings[env]);
                if (normalized) normalizedBindings[env] = normalized;
              }
              if (JSON.stringify(normalizedBindings) !== JSON.stringify(next.xmtpBindings)) {
                if (Object.keys(normalizedBindings).length > 0) next.xmtpBindings = normalizedBindings;
                else delete next.xmtpBindings;
                changed = true;
              }
            }

            if (changed) await cursor.update(next);
            cursor = await cursor.continue();
          }
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

      // Collaboration State Store
      if (!db.objectStoreNames.contains('collaborationStates')) {
        db.createObjectStore('collaborationStates', { keyPath: 'notebookId' });
      }
      if (!db.objectStoreNames.contains('collaborationStatesByEnv')) {
        const collaborationStatesByEnv = db.createObjectStore('collaborationStatesByEnv', {
          keyPath: ['notebookId', 'env'],
        });
        collaborationStatesByEnv.createIndex('by-notebook', 'notebookId');
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
    if (!ensureDefaultNotebookPromise) {
      ensureDefaultNotebookPromise = (async () => {
        const db = await this.getDb();
        const allNotebooks = await db.getAll('notebooks'); // No key check needed now
        if (allNotebooks.length > 0) {
          return allNotebooks.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        }
        return this.createNotebook({ name: 'My Notebook' });
      })().finally(() => {
        ensureDefaultNotebookPromise = null;
      });
    }

    return ensureDefaultNotebookPromise;
  },

  async getAllNotebooks(): Promise<Notebook[]> {
    const db = await this.getDb();
    const notebooks = await db.getAllFromIndex('notebooks', 'by-updated').then(nbs => nbs.reverse());
    return notebooks;
  },

  async getNotebook(id: string): Promise<Notebook | undefined> {
    const db = await this.getDb();
    return db.get('notebooks', id);
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

  async createReplicaNotebook(notebook: Notebook): Promise<Notebook> {
    const db = await this.getDb();
    await db.put('notebooks', notebook);
    return notebook;
  },

  async updateNotebook(id: string, updates: Partial<Omit<Notebook, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Notebook | undefined> {
    const db = await this.getDb();
    const notebook = await db.get('notebooks', id);
    if (!notebook) return undefined;
    const updatedNotebook: Notebook = { ...notebook, ...updates, updatedAt: Date.now() };
    await db.put('notebooks', updatedNotebook);
    return updatedNotebook;
  },

  // --- Collaboration state operations ---
  async getCollaborationState(
    notebookId: string,
    env: CollaborationEnvironment,
  ): Promise<CollaborationState | undefined> {
    const db = await this.getDb();
    const exact = await db.get('collaborationStatesByEnv', [notebookId, env]);
    if (exact) return exact;

    // V6 stored one state per notebook. Migrate it lazily into its recorded
    // environment. Environment-less records are ambiguous and must be dropped
    // rather than assigned to whichever network happens to read them first.
    const tx = db.transaction(['collaborationStates', 'collaborationStatesByEnv'], 'readwrite');
    const rechecked = await tx.objectStore('collaborationStatesByEnv').get([notebookId, env]);
    if (rechecked) {
      await tx.done;
      return rechecked;
    }
    const legacy = await tx.objectStore('collaborationStates').get(notebookId);
    if (!legacy) {
      await tx.done;
      return undefined;
    }
    if (!legacy.env) {
      await tx.objectStore('collaborationStates').delete(notebookId);
      await tx.done;
      return undefined;
    }
    if (legacy.env !== env) {
      await tx.done;
      return undefined;
    }
    const migrated: CollaborationState = {
      ...legacy,
      conversationId: normalizeConversationId(legacy.conversationId),
      env,
    };
    await tx.objectStore('collaborationStatesByEnv').put(migrated);
    await tx.objectStore('collaborationStates').delete(notebookId);
    await tx.done;
    return migrated;
  },

  async putCollaborationState(
    notebookId: string,
    state: ArrayBuffer,
    conversationId: string | null,
    env: CollaborationEnvironment,
  ): Promise<CollaborationState> {
    const db = await this.getDb();
    const collaborationState: CollaborationState = {
      notebookId,
      state,
      conversationId: normalizeConversationId(conversationId),
      env,
      updatedAt: Date.now(),
    };
    await db.put('collaborationStatesByEnv', collaborationState);
    return collaborationState;
  },

  async deleteCollaborationState(
    notebookId: string,
    env?: CollaborationEnvironment,
  ): Promise<boolean> {
    const db = await this.getDb();
    const tx = db.transaction(['collaborationStates', 'collaborationStatesByEnv'], 'readwrite');
    if (env) {
      await tx.objectStore('collaborationStatesByEnv').delete([notebookId, env]);
      const legacy = await tx.objectStore('collaborationStates').get(notebookId);
      if (!legacy?.env || legacy.env === env) {
        await tx.objectStore('collaborationStates').delete(notebookId);
      }
    } else {
      let cursor = await tx.objectStore('collaborationStatesByEnv')
        .index('by-notebook')
        .openKeyCursor(IDBKeyRange.only(notebookId));
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.objectStore('collaborationStates').delete(notebookId);
    }
    await tx.done;
    return true;
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

  async upsertExternalFolder(folder: Folder): Promise<Folder> {
    const db = await this.getDb();
    const tx = db.transaction('folders', 'readwrite');
    const store = tx.objectStore('folders');
    const existing = await store.get(folder.id);
    if (existing && existing.notebookId !== folder.notebookId) {
      await tx.done;
      throw new Error(`Folder ${folder.id} belongs to notebook ${existing.notebookId}, not ${folder.notebookId}`);
    }
    await store.put(folder);
    await tx.done;
    return folder;
  },

  async deleteExternalFolder(id: string, expectedNotebookId: string): Promise<boolean> {
    const db = await this.getDb();
    const tx = db.transaction('folders', 'readwrite');
    const store = tx.objectStore('folders');
    const existing = await store.get(id);
    if (!existing) {
      await tx.done;
      return false;
    }
    if (existing.notebookId !== expectedNotebookId) {
      await tx.done;
      throw new Error(`Folder ${id} belongs to notebook ${existing.notebookId}, not ${expectedNotebookId}`);
    }
    // Remote projections materialize the complete folder/note graph. Do not
    // perform the local deleteFolder reparenting side effects here: the
    // projected child folders and notes are persisted through their own
    // serialized queues.
    await store.delete(id);
    await tx.done;
    return true;
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
    while (notesCursor) {
      await notesCursor.update({ ...notesCursor.value, folderId: targetParentId, updatedAt: Date.now() });
      notesCursor = await notesCursor.continue();
    }
    // Re-parent subfolders
    let subfoldersCursor = await foldersStore.index('by-parent-folder').openCursor(IDBKeyRange.only(id));
    while (subfoldersCursor) {
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
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    const existing = await store.get(note.id);
    if (existing && existing.notebookId !== note.notebookId) {
      await tx.done;
      throw new Error(`Note ${note.id} belongs to notebook ${existing.notebookId}, not ${note.notebookId}`);
    }
    await store.put(note);
    await tx.done;
    return note;
  },

  async deleteNote(id: string, expectedNotebookId?: string): Promise<boolean> {
    const db = await this.getDb();
    if (!expectedNotebookId) {
      await db.delete('notes', id);
      return true;
    }

    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    const existing = await store.get(id);
    if (!existing) {
      await tx.done;
      return false;
    }
    if (existing.notebookId !== expectedNotebookId) {
      await tx.done;
      throw new Error(`Note ${id} belongs to notebook ${existing.notebookId}, not ${expectedNotebookId}`);
    }
    await store.delete(id);
    await tx.done;
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

    // Use a transaction to delete notebook, folders, notes, and collaboration state atomically
    const tx = db.transaction(
      ['notebooks', 'folders', 'notes', 'collaborationStates', 'collaborationStatesByEnv'],
      'readwrite',
    );
    const notesStore = tx.objectStore('notes');
    const foldersStore = tx.objectStore('folders');
    const notebooksStore = tx.objectStore('notebooks');
    const collaborationStatesStore = tx.objectStore('collaborationStates');
    const collaborationStatesByEnvStore = tx.objectStore('collaborationStatesByEnv');

    // 1. Delete all notes associated with the notebook
    let notesCursor = await notesStore.index('by-notebook-updated').openCursor(IDBKeyRange.bound([notebookId, -Infinity], [notebookId, Infinity]));
    while (notesCursor) {
      await notesCursor.delete();
      notesCursor = await notesCursor.continue();
    }

    // 2. Delete all folders associated with the notebook
    let foldersCursor = await foldersStore.index('by-notebook').openCursor(IDBKeyRange.only(notebookId));
    while (foldersCursor) {
      await foldersCursor.delete();
      foldersCursor = await foldersCursor.continue();
    }

    // 3. Delete collaboration state associated with the notebook
    await collaborationStatesStore.delete(notebookId);
    let collaborationStateCursor = await collaborationStatesByEnvStore
      .index('by-notebook')
      .openKeyCursor(IDBKeyRange.only(notebookId));
    while (collaborationStateCursor) {
      await collaborationStateCursor.delete();
      collaborationStateCursor = await collaborationStateCursor.continue();
    }

    // 4. Delete the notebook itself
    await notebooksStore.delete(notebookId);

    await tx.done;
    console.log(`Notebook ${notebookId} and all its contents deleted.`);
    return true;
  },
};
