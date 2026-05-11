import React, { useEffect, RefObject, useRef, useState } from 'react';
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

function serializeInlineNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.replace(/\u00a0/g, ' ') || '';
  }

  if (!(node instanceof HTMLElement)) {
    return '';
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === 'br') return '\n';

  const childMarkdown = Array.from(node.childNodes).map(serializeInlineNode).join('');
  const trimmedChildMarkdown = childMarkdown.trim();

  if (!trimmedChildMarkdown) return '';
  if (tagName === 'strong' || tagName === 'b') return `**${trimmedChildMarkdown}**`;
  if (tagName === 'em' || tagName === 'i') return `*${trimmedChildMarkdown}*`;
  if (tagName === 'code') return `\`${trimmedChildMarkdown.replace(/`/g, '\\`')}\``;
  if (tagName === 'a') {
    const href = node.getAttribute('href');
    return href ? `[${trimmedChildMarkdown}](${href})` : trimmedChildMarkdown;
  }

  return childMarkdown;
}

function serializeInlineChildren(element: HTMLElement): string {
  return Array.from(element.childNodes)
    .map(serializeInlineNode)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serializeList(element: HTMLElement, depth = 0): string {
  const ordered = element.tagName.toLowerCase() === 'ol';
  const indent = '  '.repeat(depth);
  const items = Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li');

  return items
    .map((item, index) => {
      const clone = item.cloneNode(true) as HTMLElement;
      const nestedLists = Array.from(clone.children).filter((child): child is HTMLElement => {
        const tagName = child.tagName.toLowerCase();
        return tagName === 'ul' || tagName === 'ol';
      });

      nestedLists.forEach(list => list.remove());
      const marker = ordered ? `${index + 1}.` : '-';
      const itemMarkdown = serializeInlineChildren(clone).replace(/\n+/g, ' ').trim() || ' ';
      const nestedMarkdown = nestedLists.map(list => serializeList(list, depth + 1)).filter(Boolean).join('\n');

      return [`${indent}${marker} ${itemMarkdown}`, nestedMarkdown].filter(Boolean).join('\n');
    })
    .join('\n');
}

function serializeBlockElement(element: HTMLElement): string {
  const tagName = element.tagName.toLowerCase();
  const inlineMarkdown = serializeInlineChildren(element);

  if (/^h[1-6]$/.test(tagName)) {
    return `${'#'.repeat(Number(tagName.slice(1)))} ${inlineMarkdown}`.trim();
  }

  if (tagName === 'ul' || tagName === 'ol') return serializeList(element);
  if (tagName === 'blockquote') {
    return serializeMarkdownDocument(element)
      .split('\n')
      .map(line => (line ? `> ${line}` : '>'))
      .join('\n');
  }
  if (tagName === 'pre') return `\`\`\`\n${element.textContent?.trimEnd() || ''}\n\`\`\``;
  if (tagName === 'hr') return '---';
  if (tagName === 'div' || tagName === 'section' || tagName === 'article') return serializeMarkdownDocument(element);

  return inlineMarkdown;
}

function serializeMarkdownDocument(element: HTMLElement): string {
  return Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() || '';
      if (node instanceof HTMLElement) return serializeBlockElement(node);
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface RichMarkdownEditorProps {
  markdown: string;
  onMarkdownInput: (markdown: string) => void;
  onMarkdownCommit: (markdown: string) => void;
}

const RichMarkdownEditor = React.memo(function RichMarkdownEditor({ markdown, onMarkdownInput, onMarkdownCommit }: RichMarkdownEditorProps) {
  const editorRef = useRef<HTMLElement>(null);
  const [renderedMarkdown, setRenderedMarkdown] = useState(markdown);
  const lastSyncedMarkdownRef = useRef(markdown);
  const latestMarkdownRef = useRef(markdown);

  useEffect(() => {
    const editor = editorRef.current;
    const editorHasFocus = !!editor && (document.activeElement === editor || editor.contains(document.activeElement));

    if (!editorHasFocus && markdown !== lastSyncedMarkdownRef.current) {
      lastSyncedMarkdownRef.current = markdown;
      latestMarkdownRef.current = markdown;
      setRenderedMarkdown(markdown);
    }
  }, [markdown]);

  const handleInput = () => {
    if (!editorRef.current) return;

    const nextMarkdown = serializeMarkdownDocument(editorRef.current);
    lastSyncedMarkdownRef.current = nextMarkdown;
    latestMarkdownRef.current = nextMarkdown;
    onMarkdownInput(nextMarkdown);
  };

  const handleBlur = () => {
    if (!editorRef.current) return;

    const nextMarkdown = latestMarkdownRef.current || serializeMarkdownDocument(editorRef.current);
    lastSyncedMarkdownRef.current = nextMarkdown;
    latestMarkdownRef.current = nextMarkdown;
    setRenderedMarkdown(nextMarkdown);
    onMarkdownCommit(nextMarkdown);
  };

  const editorHasFocus = typeof document !== 'undefined'
    && document.activeElement instanceof HTMLElement
    && !!document.activeElement.closest('[data-markdown-editor="true"]');
  const markdownForRender = editorHasFocus ? renderedMarkdown : latestMarkdownRef.current || markdown;

  return (
    <article
      ref={editorRef}
      className="stormdance-markdown-preview stormdance-markdown-editor min-h-0 min-w-0 flex-1 overflow-auto p-4 text-left text-sm leading-6 text-gray-800 dark:text-gray-100"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Editable rendered markdown"
      data-markdown-editor="true"
      data-empty={!markdownForRender.trim()}
      onInput={handleInput}
      onBlur={handleBlur}
    >
      {markdownForRender.trim() ? <ReactMarkdown>{markdownForRender}</ReactMarkdown> : null}
    </article>
  );
}, (previousProps, nextProps) => {
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    const focusedMarkdownEditor = document.activeElement.closest('[data-markdown-editor="true"]');
    if (focusedMarkdownEditor) return true;
  }

  return previousProps.markdown === nextProps.markdown;
});

export function Editor({ note, onUpdateNote, titleInputRef, textAreaRef }: EditorProps) {
  const [editorMode, setEditorMode] = useState<EditorMode>(getInitialEditorMode);
  const [content, setContent] = useState(note?.content || '');
  const contentRef = useRef(note?.content || '');
  const currentNoteIdRef = useRef(note?.id || null);
  const richEditPendingRef = useRef(false);
  const lastRichInputMarkdownRef = useRef<string | null>(null);
  const richSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (richSaveTimerRef.current !== null) {
        window.clearTimeout(richSaveTimerRef.current);
        richSaveTimerRef.current = null;
      }
    };
  }, [note?.id]);

  useEffect(() => {
    if (note) {
      const sameNote = currentNoteIdRef.current === note.id;
      const nextContent = note.content || '';
      if (!sameNote) {
        richEditPendingRef.current = false;
        lastRichInputMarkdownRef.current = null;
      }

      if (sameNote && richEditPendingRef.current && nextContent !== contentRef.current) {
        if (titleInputRef.current) {
          titleInputRef.current.value = note.title || '';
        }
        return;
      }
      if (sameNote && nextContent === contentRef.current) {
        richEditPendingRef.current = false;
      }

      const markdownEditorHasFocus = document.activeElement instanceof HTMLElement && !!document.activeElement.closest('[data-markdown-editor="true"]');
      if (editorMode === 'markdown' && markdownEditorHasFocus) return;

      // Update input values when note changes
      if (titleInputRef.current) {
        titleInputRef.current.value = note.title || '';
      }
      currentNoteIdRef.current = note.id;
      contentRef.current = nextContent;
      setContent(nextContent);
      if (textAreaRef.current) {
        textAreaRef.current.value = nextContent;
      }
    }
  }, [editorMode, note, titleInputRef, textAreaRef]);

  const handleTitleInput = (e: React.FormEvent<HTMLInputElement>) => {
    if (note) {
      onUpdateNote(note.id, { title: e.currentTarget.value });
    }
  };

  const syncLocalContent = (nextContent: string, syncState = true) => {
    contentRef.current = nextContent;
    if (syncState) setContent(nextContent);
    if (textAreaRef.current) {
      textAreaRef.current.value = nextContent;
    }
  };

  const persistContent = (nextContent: string) => {
    if (note) {
      onUpdateNote(note.id, { content: nextContent });
    }
  };

  const updateContent = (nextContent: string) => {
    syncLocalContent(nextContent);
    persistContent(nextContent);
  };

  const scheduleRichContentSave = (nextContent: string) => {
    if (richSaveTimerRef.current !== null) {
      window.clearTimeout(richSaveTimerRef.current);
    }

    richSaveTimerRef.current = window.setTimeout(() => {
      richSaveTimerRef.current = null;
      persistContent(nextContent);
    }, 75);
  };

  const handleRichMarkdownInput = (nextMarkdown: string) => {
    richEditPendingRef.current = true;
    lastRichInputMarkdownRef.current = nextMarkdown;
    syncLocalContent(nextMarkdown);
    scheduleRichContentSave(nextMarkdown);
  };

  const handleRichMarkdownCommit = (nextMarkdown: string) => {
    const markdownToCommit = lastRichInputMarkdownRef.current || nextMarkdown;
    richEditPendingRef.current = true;
    syncLocalContent(markdownToCommit);
    if (richSaveTimerRef.current !== null) {
      window.clearTimeout(richSaveTimerRef.current);
      richSaveTimerRef.current = null;
    }
    persistContent(markdownToCommit);
    lastRichInputMarkdownRef.current = null;
  };

  const handleContentInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    updateContent(e.currentTarget.value);
  };

  const handleEditorModeChange = (nextMode: EditorMode) => {
    if (editorMode === 'markdown' && nextMode !== 'markdown') {
      handleRichMarkdownCommit(contentRef.current);
      setContent(contentRef.current);
    }
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
  const showMarkdownPreview = editorMode === 'split';
  const showRichMarkdownEditor = editorMode === 'markdown';
  const editorBodyLayout = editorMode === 'split' ? 'flex flex-col md:flex-row' : 'flex flex-col';
  const editorPaneClass =
    editorMode === 'split'
      ? 'border-b border-gray-200 md:border-b-0 md:border-r dark:border-gray-800'
      : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-white p-4 dark:bg-gray-950">
      <div className="mb-4 flex shrink-0 items-start gap-3">
        <input
          ref={titleInputRef}
          type="text"
          defaultValue={note.title || ''}
          onInput={handleTitleInput}
          placeholder="Note Title"
          aria-label="Note title"
          className="min-w-0 flex-1 border-b border-gray-300 bg-transparent p-2 text-2xl font-bold focus:border-yellow-400 focus:outline-none dark:border-gray-700 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
        />
        <div
          className="mt-1 inline-flex shrink-0 rounded-md border border-gray-200 bg-white/95 p-0.5 shadow-md shadow-gray-900/10 backdrop-blur dark:border-gray-700 dark:bg-gray-950/95 dark:shadow-black/30"
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
                <span className="hidden md:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className={`min-h-0 flex-1 ${editorBodyLayout}`}>
          {showTextEditor && (
            <div className={`min-h-0 min-w-0 flex-1 ${editorPaneClass}`}>
              <textarea
                ref={textAreaRef}
                defaultValue={content}
                onInput={handleContentInput}
                placeholder="Start writing your note..."
                aria-label={editorMode === 'text' ? 'Note content' : 'Note markdown source'}
                className="h-full min-h-0 w-full resize-none bg-transparent p-3 focus:outline-none dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
              />
            </div>
          )}

          {showRichMarkdownEditor && (
            <RichMarkdownEditor
              key={note.id}
              markdown={content}
              onMarkdownInput={handleRichMarkdownInput}
              onMarkdownCommit={handleRichMarkdownCommit}
            />
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
