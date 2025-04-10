import { useState, useEffect, RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import { Note } from '../../lib/db';

interface EditorProps {
  note: Note | null;
  onUpdateNote: (id: string, updates: Partial<Note>) => void;
  titleInputRef?: RefObject<HTMLInputElement>;
  textAreaRef?: RefObject<HTMLTextAreaElement>;
}

export function Editor({ note, onUpdateNote, titleInputRef, textAreaRef }: EditorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [activeTab, setActiveTab] = useState('edit');

  useEffect(() => {
    if (note) {
      setTitle(note.title);
      setContent(note.content);
    } else {
      setTitle('');
      setContent('');
    }
  }, [note]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (note) {
      onUpdateNote(note.id, { title: newTitle });
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    if (note) {
      onUpdateNote(note.id, { content: newContent });
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
    <div className="p-4 h-full flex flex-col bg-white dark:bg-gray-950">
      <input
        ref={titleInputRef}
        type="text"
        value={title}
        onChange={handleTitleChange}
        placeholder="Note Title"
        className="text-2xl font-bold mb-4 p-2 border-b bg-transparent border-gray-300 dark:border-gray-700 focus:outline-none focus:border-yellow-400 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
      />
      <textarea
        ref={textAreaRef}
        value={content}
        onChange={handleContentChange}
        placeholder="Start writing your note..."
        className="flex-1 w-full p-2 bg-transparent focus:outline-none resize-none dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
      />
    </div>
  );
}
