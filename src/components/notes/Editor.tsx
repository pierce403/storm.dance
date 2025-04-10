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
      <div className="flex items-center justify-center h-full text-gray-500">
        <p>Select a note or create a new one</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4">
      <input
        type="text"
        value={title}
        onChange={handleTitleChange}
        placeholder="Note title"
        className="text-xl font-semibold mb-4 p-2 border-b focus:outline-none focus:border-blue-500"
        ref={titleInputRef}
      />
      <div className="flex-1 flex flex-col">
        <div className="border-b mb-2">
          <button
            className={`px-4 py-2 ${activeTab === 'edit' ? 'border-b-2 border-blue-500' : ''}`}
            onClick={() => setActiveTab('edit')}
          >
            Edit
          </button>
          <button
            className={`px-4 py-2 ${activeTab === 'preview' ? 'border-b-2 border-blue-500' : ''}`}
            onClick={() => setActiveTab('preview')}
          >
            Preview
          </button>
        </div>
        
        {activeTab === 'edit' ? (
          <textarea
            value={content}
            onChange={handleContentChange}
            placeholder="Write your note in Markdown..."
            className="flex-1 resize-none font-mono p-2 border rounded-md focus:outline-none focus:border-blue-500"
            ref={textAreaRef}
          />
        ) : (
          <div className="flex-1 overflow-auto p-4 border rounded-md">
            {content ? (
              <ReactMarkdown>{content}</ReactMarkdown>
            ) : (
              <p className="text-gray-500">Nothing to preview</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
