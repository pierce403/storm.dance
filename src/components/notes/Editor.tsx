import React, { useEffect, RefObject } from 'react';
import { Note } from '../../lib/db';

interface EditorProps {
  note: Note | null;
  onUpdateNote: (id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => void;
  titleInputRef: RefObject<HTMLInputElement>;
  textAreaRef: RefObject<HTMLTextAreaElement>;
}

export function Editor({ note, onUpdateNote, titleInputRef, textAreaRef }: EditorProps) {
  useEffect(() => {
    if (note) {
      // Update input values when note changes
      if (titleInputRef.current) {
        titleInputRef.current.value = note.title || '';
      }
      if (textAreaRef.current) {
        textAreaRef.current.value = note.content || '';
      }
    }
  }, [note, titleInputRef, textAreaRef]);

  const handleTitleInput = (e: React.FormEvent<HTMLInputElement>) => {
    if (note) {
      onUpdateNote(note.id, { title: e.currentTarget.value });
    }
  };

  const handleContentInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (note) {
      onUpdateNote(note.id, { content: e.currentTarget.value });
    }
  };

  if (!note) {
    return (
      <div className="p-4 h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
        <p className="italic">Select a note to view or edit.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white p-4 dark:bg-gray-950">
      <input
        ref={titleInputRef}
        type="text"
        defaultValue={note.title || ''}
        onInput={handleTitleInput}
        placeholder="Note Title"
        aria-label="Note title"
        className="text-2xl font-bold mb-4 p-2 border-b bg-transparent border-gray-300 dark:border-gray-700 focus:outline-none focus:border-yellow-400 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
      />
      <textarea
        ref={textAreaRef}
        defaultValue={note.content || ''}
        onInput={handleContentInput}
        placeholder="Start writing your note..."
        aria-label="Note content"
        className="min-h-0 flex-1 w-full resize-none bg-transparent p-2 focus:outline-none dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
      />
    </div>
  );
}
