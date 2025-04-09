import { openDB, DBSchema, IDBPDatabase } from 'idb';

// --- Interfaces ---

export interface Notebook {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  notebookId: string;
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
  notes: {
    key: string;
    value: Note;
    indexes: {
      'by-updated': number;
      'by-notebook-updated': [string, number];
    };
  };
}

export const DB_NAME = 'storm-dance-db';
const DB_VERSION = 2;

const initDB = async (): Promise<IDBPDatabase<StormDanceDB>> => {
  return openDB<StormDanceDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      console.log(`Upgrading DB from version ${oldVersion} to ${DB_VERSION}`);

      if (!db.objectStoreNames.contains('notebooks')) {
        const notebooksStore = db.createObjectStore('notebooks', { keyPath: 'id' });
        notebooksStore.createIndex('by-updated', 'updatedAt');
        console.log("Created 'notebooks' object store");
      }

      if (db.objectStoreNames.contains('notes')) {
        if (oldVersion < 2) {
           const notesStore = tx.objectStore('notes');
           if (!notesStore.indexNames.contains('by-notebook-updated')) {
             notesStore.createIndex('by-notebook-updated', ['notebookId', 'updatedAt']);
             console.log("Created 'by-notebook-updated' index on 'notes'");
           }
        }
      } else {
          const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
          notesStore.createIndex('by-updated', 'updatedAt');
          notesStore.createIndex('by-notebook-updated', ['notebookId', 'updatedAt']);
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

  async getAllNotes(notebookId?: string): Promise<Note[]> {
    const db = await initDB();
    if (notebookId) {
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

  async deleteNote(id: string): Promise<boolean> {
    const db = await initDB();
    await db.delete('notes', id);
    return true;
  },
};
