import { openDB, DBSchema } from 'idb';

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface StormDanceDB extends DBSchema {
  notes: {
    key: string;
    value: Note;
    indexes: {
      'by-updated': number;
    };
  };
}

const DB_NAME = 'storm-dance-db';
const DB_VERSION = 1;

export const initDB = async () => {
  return openDB<StormDanceDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
      notesStore.createIndex('by-updated', 'updatedAt');
    },
  });
};

export const dbService = {
  async getAllNotes(): Promise<Note[]> {
    const db = await initDB();
    return db.getAllFromIndex('notes', 'by-updated');
  },

  async getNote(id: string): Promise<Note | undefined> {
    const db = await initDB();
    return db.get('notes', id);
  },

  async createNote(note: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>): Promise<Note> {
    const db = await initDB();
    const timestamp = Date.now();
    const newNote: Note = {
      id: crypto.randomUUID(),
      ...note,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.put('notes', newNote);
    return newNote;
  },

  async updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Note | undefined> {
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
