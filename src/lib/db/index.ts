import { openDB, DBSchema, IDBPDatabase, StoreValue, IndexKey } from 'idb';

// --- Interfaces ---

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
  parentFolderId: string | null; // null means root level folder
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  notebookId: string;
  folderId: string | null; // null means not in a folder (root level)
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
    indexes: {
      'by-updated': number;
    };
  };
  folders: {
    key: string;
    value: Folder;
    indexes: {
      'by-updated': number;
      'by-notebook': string;
      'by-parent-folder': string | null;
    };
  };
  notes: {
    key: string;
    value: Note;
    indexes: {
      'by-updated': number;
      'by-notebook-updated': [string, number];
      'by-folder': string | null;
    };
  };
}

export const DB_NAME = 'storm-dance-db';
const DB_VERSION = 3; // Increment version for schema updates

const initDB = async (): Promise<IDBPDatabase<StormDanceDB>> => {
  return openDB<StormDanceDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      console.log(`Upgrading DB from version ${oldVersion} to ${newVersion ?? DB_VERSION}`);

      // Create notebooks store if it doesn't exist
      if (!db.objectStoreNames.contains('notebooks')) {
        const notebooksStore = db.createObjectStore('notebooks', { keyPath: 'id' });
        notebooksStore.createIndex('by-updated', 'updatedAt');
        console.log("Created 'notebooks' object store");
      }

      // Create folders store if it doesn't exist
      if (!db.objectStoreNames.contains('folders')) {
        const foldersStore = db.createObjectStore('folders', { keyPath: 'id' });
        foldersStore.createIndex('by-updated', 'updatedAt');
        foldersStore.createIndex('by-notebook', 'notebookId');
        foldersStore.createIndex('by-parent-folder', 'parentFolderId');
        console.log("Created 'folders' object store with indexes");
      }

      // Update notes store
      if (db.objectStoreNames.contains('notes')) {
        const notesStore = tx.objectStore('notes');
        
        // Add index for by-notebook-updated if needed
        if (oldVersion < 2 && !notesStore.indexNames.contains('by-notebook-updated')) {
          notesStore.createIndex('by-notebook-updated', ['notebookId', 'updatedAt']);
          console.log("Created 'by-notebook-updated' index on 'notes'");
        }
        
        // Add index for folders if needed
        if (oldVersion < 3 && !notesStore.indexNames.contains('by-folder')) {
          notesStore.createIndex('by-folder', 'folderId');
          console.log("Created 'by-folder' index on 'notes'");
          
          // Migrate existing notes to have folderId = null
          const notesCursor = tx.objectStore('notes').openCursor();
          notesCursor.then(function processNotes(cursor): Promise<void> | undefined {
            if (!cursor) return;
            
            const note = cursor.value as Note;
            if (!('folderId' in note)) {
              note.folderId = null;
              cursor.update(note);
            }
            
            return cursor.continue().then(processNotes);
          });
        }
      } else {
        // Create notes store if it doesn't exist
        const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
        notesStore.createIndex('by-updated', 'updatedAt');
        notesStore.createIndex('by-notebook-updated', ['notebookId', 'updatedAt']);
        notesStore.createIndex('by-folder', 'folderId');
        console.log("Created 'notes' object store with indexes");
      }
    },
    blocked() {
      console.error("Database upgrade blocked. Please close other tabs running this application.");
    },
    blocking() {
      console.warn("Database upgrade is blocking other tabs.");
    },
  });
};

export type CreateNoteInput = Omit<Note, 'id' | 'createdAt' | 'updatedAt'>;
export type CreateFolderInput = Omit<Folder, 'id' | 'createdAt' | 'updatedAt'>;

export const dbService = {

  async getAllNotebooks(): Promise<Notebook[]> {
    const db = await initDB();
    return db.getAllFromIndex('notebooks', 'by-updated').then(notebooks => notebooks.reverse());
  },

  async createNotebook(notebookInput: Omit<Notebook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Notebook> {
    const db = await initDB();
    const timestamp = Date.now();
    const newNotebook: Notebook = {
      id: crypto.randomUUID(),
      ...notebookInput,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.put('notebooks', newNotebook);
    return newNotebook;
  },

  async _ensureDefaultNotebook(): Promise<Notebook> {
    const notebooks = await this.getAllNotebooks();
    if (notebooks.length > 0) {
      return notebooks[0];
    } else {
      console.log("No notebooks found, creating default notebook.");
      return this.createNotebook({ name: "My Notebook" });
    }
  },

  // Folder operations
  async getAllFolders(notebookId: string): Promise<Folder[]> {
    const db = await initDB();
    return db.getAllFromIndex('folders', 'by-notebook', notebookId);
  },

  async createFolder(folderInput: CreateFolderInput): Promise<Folder> {
    const db = await initDB();
    const timestamp = Date.now();
    const newFolder: Folder = {
      id: crypto.randomUUID(),
      ...folderInput,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.put('folders', newFolder);
    return newFolder;
  },

  async updateFolder(id: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>): Promise<Folder | undefined> {
    const db = await initDB();
    const folder = await db.get('folders', id);
    
    if (!folder) return undefined;
    
    const updatedFolder: Folder = {
      ...folder,
      ...updates,
      updatedAt: Date.now(),
    };
    
    await db.put('folders', updatedFolder);
    return updatedFolder;
  },

  async deleteFolder(id: string): Promise<boolean> {
    const db = await initDB();
    
    // Get notes in this folder
    const notes = await db.getAllFromIndex('notes', 'by-folder', id);
    
    // Get subfolders
    const subfolders = await db.getAllFromIndex('folders', 'by-parent-folder', id);
    
    // Transaction to delete everything
    const tx = db.transaction(['folders', 'notes'], 'readwrite');
    
    // Move notes to parent folder or null
    const folder = await db.get('folders', id);
    const parentFolderId = folder?.parentFolderId;
    
    // Update each note to new parent
    for (const note of notes) {
      note.folderId = parentFolderId ?? null;
      note.updatedAt = Date.now();
      await tx.objectStore('notes').put(note);
    }
    
    // Move subfolders to parent
    for (const subfolder of subfolders) {
      subfolder.parentFolderId = parentFolderId ?? null;
      subfolder.updatedAt = Date.now();
      await tx.objectStore('folders').put(subfolder);
    }
    
    // Delete the folder
    await tx.objectStore('folders').delete(id);
    await tx.done;
    
    return true;
  },

  // Note operations
  async getAllNotes(notebookId?: string, folderId?: string | null): Promise<Note[]> {
    const db = await initDB();
    
    if (notebookId && folderId !== undefined) {
      // Get notes by folder
      return db.getAllFromIndex('notes', 'by-folder', folderId)
        .then(notes => notes
          .filter(note => note.notebookId === notebookId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
        );
    } else if (notebookId) {
      // Get all notes in notebook
      const index = db.transaction('notes').objectStore('notes').index('by-notebook-updated');
      const range = IDBKeyRange.bound([notebookId, -Infinity], [notebookId, Infinity]);
      return index.getAll(range).then(notes => notes.reverse());
    } else {
      console.warn("getAllNotes called without notebookId, returning all notes.");
      return db.getAllFromIndex('notes', 'by-updated').then(notes => notes.reverse());
    }
  },

  async getNote(id: string): Promise<Note | undefined> {
    const db = await initDB();
    return db.get('notes', id);
  },

  async createNote(noteInput: CreateNoteInput): Promise<Note> {
    const db = await initDB();
    const timestamp = Date.now();
    const newNote: Note = {
      id: crypto.randomUUID(),
      ...noteInput,
      createdAt: timestamp,
      updatedAt: timestamp,
      folderId: noteInput.folderId ?? null,
    };
    if (!newNote.notebookId) {
      throw new Error("Cannot create note without a notebookId");
    }
    await db.put('notes', newNote);
    return newNote;
  },

  async updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>): Promise<Note | undefined> {
    const db = await initDB();
    const note = await db.get('notes', id);
    
    if (!note) return undefined;
    
    const updatedNote: Note = {
      ...note,
      ...updates,
      updatedAt: Date.now(),
    };
    
    await db.put('notes', updatedNote);
    return updatedNote;
  },

  async moveNoteToFolder(noteId: string, folderId: string | null): Promise<Note | undefined> {
    return this.updateNote(noteId, { folderId });
  },

  async deleteNote(id: string): Promise<boolean> {
    const db = await initDB();
    await db.delete('notes', id);
    return true;
  },
};
