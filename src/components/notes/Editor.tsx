import React, { useEffect, RefObject, useState } from 'react';
import { Columns2, Eye, FileText, type LucideIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Note } from '../../lib/db';

interface EditorProps {
  note: Note | null;
  onUpdateNote: (id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => void;
  titleInputRef: RefObject<HTMLInputElement>;
  textAreaRef: RefObject<HTMLTextAreaElement>;
}

type EditorMode = 'text' | 'split' | 'markdown';

const EDITOR_MODE_STORAGE_KEY = 'stormdance.editor.mode';

const EDITOR_MODES: Array<{ value: EditorMode; label: string; Icon: LucideIcon }> = [
  { value: 'text', label: 'Text', Icon: FileText },
  { value: 'split', label: 'Split', Icon: Columns2 },
  { value: 'markdown', label: 'Markdown', Icon: Eye },
];

function getInitialEditorMode(): EditorMode {
  if (typeof window === 'undefined') return 'text';

  const storedMode = window.localStorage.getItem(EDITOR_MODE_STORAGE_KEY);
  if (storedMode === 'text' || storedMode === 'split' || storedMode === 'markdown') {
    return storedMode;
  }

  return 'text';
}

export function Editor({ note, onUpdateNote, titleInputRef, textAreaRef }: EditorProps) {
  const [editorMode, setEditorMode] = useState<EditorMode>(getInitialEditorMode);
  const [content, setContent] = useState(note?.content || '');

  useEffect(() => {
    if (note) {
      // Update input values when note changes
      if (titleInputRef.current) {
        titleInputRef.current.value = note.title || '';
      }
      setContent(note.content || '');
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
      const nextContent = e.currentTarget.value;
      setContent(nextContent);
      onUpdateNote(note.id, { content: nextContent });
    }
  };

  const handleEditorModeChange = (nextMode: EditorMode) => {
    setEditorMode(nextMode);
    window.localStorage.setItem(EDITOR_MODE_STORAGE_KEY, nextMode);
  };

  if (!note) {
    return (
      <div className="p-4 h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
        <p className="italic">Select a note to view or edit.</p>
      </div>
    );
  }

  const showTextEditor = editorMode === 'text' || editorMode === 'split';
  const showMarkdownPreview = editorMode === 'split' || editorMode === 'markdown';

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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className="flex shrink-0 items-center justify-end border-b border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-800 dark:bg-gray-900">
          <div
            className="inline-flex rounded-md border border-gray-200 bg-white p-0.5 shadow-sm dark:border-gray-700 dark:bg-gray-950"
            role="radiogroup"
            aria-label="Editor display mode"
          >
            {EDITOR_MODES.map(({ value, label, Icon }) => {
              const isSelected = editorMode === value;

              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${label} editor mode`}
                  title={`${label} mode`}
                  onClick={() => handleEditorModeChange(value)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${
                    isSelected
                      ? 'bg-yellow-400 text-gray-950 shadow-sm'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-50'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className={`min-h-0 flex-1 ${editorMode === 'split' ? 'flex flex-col md:flex-row' : 'flex'}`}>
          {showTextEditor && (
            <div className={`min-h-0 min-w-0 flex-1 ${editorMode === 'split' ? 'border-b border-gray-200 md:border-b-0 md:border-r dark:border-gray-800' : ''}`}>
              <textarea
                ref={textAreaRef}
                defaultValue={content}
                onInput={handleContentInput}
                placeholder="Start writing your note..."
                aria-label={editorMode === 'split' ? 'Note markdown source' : 'Note content'}
                className="h-full min-h-0 w-full resize-none bg-transparent p-3 focus:outline-none dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
              />
            </div>
          )}

          {showMarkdownPreview && (
            <article
              className="stormdance-markdown-preview min-h-0 min-w-0 flex-1 overflow-auto p-4 text-left text-sm leading-6 text-gray-800 dark:text-gray-100"
              role="region"
              aria-label="Rendered markdown preview"
            >
              {content.trim() ? (
                <ReactMarkdown>{content}</ReactMarkdown>
              ) : (
                <p className="italic text-gray-400 dark:text-gray-500">Markdown preview will appear here.</p>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
