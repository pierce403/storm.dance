import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  RefObject,
  useRef,
  useState,
} from 'react';
import {
  Bold,
  Code2,
  Columns2,
  Eye,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  type LucideIcon,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Note } from '../../lib/db';

interface EditorProps {
  note: Note | null;
  onUpdateNote: (id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => void;
  titleInputRef: RefObject<HTMLInputElement>;
  textAreaRef: RefObject<HTMLTextAreaElement>;
}

type EditorMode = 'text' | 'split' | 'markdown';
type MarkdownBlockStyle = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'quote' | 'code-block';

type MarkdownCommand =
  | { type: 'block'; style: MarkdownBlockStyle }
  | { type: 'inline'; style: 'bold' | 'italic' | 'code' }
  | { type: 'list'; style: 'bullet' | 'numbered' | 'task' }
  | { type: 'insert'; style: 'link' | 'image'; url: string }
  | { type: 'insert'; style: 'divider' };

interface RichMarkdownEditorHandle {
  applyCommand: (command: MarkdownCommand) => void;
}

const EDITOR_MODE_STORAGE_KEY = 'stormdance.editor.mode';

const EDITOR_MODES: Array<{ value: EditorMode; label: string; Icon: LucideIcon }> = [
  { value: 'text', label: 'Text', Icon: FileText },
  { value: 'split', label: 'Split', Icon: Columns2 },
  { value: 'markdown', label: 'Markdown', Icon: Eye },
];

const BLOCK_STYLES: Array<{ value: MarkdownBlockStyle; label: string }> = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'heading1', label: 'Heading 1' },
  { value: 'heading2', label: 'Heading 2' },
  { value: 'heading3', label: 'Heading 3' },
  { value: 'quote', label: 'Quote' },
  { value: 'code-block', label: 'Code block' },
];

const INLINE_TOOLBAR_ITEMS: Array<{
  label: string;
  title: string;
  Icon: LucideIcon;
  command: MarkdownCommand;
}> = [
  { label: 'Bold', title: 'Bold', Icon: Bold, command: { type: 'inline', style: 'bold' } },
  { label: 'Italic', title: 'Italic', Icon: Italic, command: { type: 'inline', style: 'italic' } },
  { label: 'Inline code', title: 'Inline code', Icon: Code2, command: { type: 'inline', style: 'code' } },
];

const LIST_TOOLBAR_ITEMS: Array<{
  label: string;
  title: string;
  Icon: LucideIcon;
  command: MarkdownCommand;
}> = [
  { label: 'Bulleted list', title: 'Bulleted list', Icon: List, command: { type: 'list', style: 'bullet' } },
  { label: 'Numbered list', title: 'Numbered list', Icon: ListOrdered, command: { type: 'list', style: 'numbered' } },
  { label: 'Task list', title: 'Task list', Icon: ListTodo, command: { type: 'list', style: 'task' } },
];

const TASK_ITEM_PREFIX_PATTERN = /^\s*\[([ xX])\]\s+(.*)$/;
const TASK_MARKDOWN_LINE_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+.*)$/;

function getInitialEditorMode(): EditorMode {
  if (typeof window === 'undefined') return 'text';

  const storedMode = window.localStorage.getItem(EDITOR_MODE_STORAGE_KEY);
  if (storedMode === 'text' || storedMode === 'split' || storedMode === 'markdown') {
    return storedMode;
  }

  return 'text';
}

function getTextFromReactNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextFromReactNode).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getTextFromReactNode(node.props.children);
  }

  return '';
}

function isNodeInsideElement(node: Node, element: HTMLElement): boolean {
  return node === element || element.contains(node);
}

function getCurrentLineRange(markdown: string, selectionStart: number, selectionEnd: number) {
  const lineStart = selectionStart === 0 ? 0 : markdown.lastIndexOf('\n', selectionStart - 1) + 1;
  const nextLineBreak = markdown.indexOf('\n', selectionEnd);
  const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak;

  return { start: lineStart, end: lineEnd };
}

function stripBlockSyntax(line: string): string {
  return line
    .replace(/^(\s*)#{1,6}\s+/, '$1')
    .replace(/^(\s*)>\s?/, '$1')
    .replace(/^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/, '$1')
    .replace(/^(\s*)(?:[-*+]|\d+[.)])\s+/, '$1');
}

function transformSelectedMarkdownLines(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  transformLine: (line: string, index: number) => string,
  emptyLine: string,
) {
  const { start, end } = getCurrentLineRange(markdown, selectionStart, selectionEnd);
  const selected = markdown.slice(start, end);
  const replacement = selected.trim()
    ? selected.split('\n').map(transformLine).join('\n')
    : emptyLine;

  return {
    markdown: `${markdown.slice(0, start)}${replacement}${markdown.slice(end)}`,
    selectionStart: start,
    selectionEnd: start + replacement.length,
  };
}

function applyMarkdownCommandToText(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  command: MarkdownCommand,
) {
  const selectedText = markdown.slice(selectionStart, selectionEnd);
  const insert = (replacement: string, innerOffset = 0, innerLength = replacement.length) => ({
    markdown: `${markdown.slice(0, selectionStart)}${replacement}${markdown.slice(selectionEnd)}`,
    selectionStart: selectionStart + innerOffset,
    selectionEnd: selectionStart + innerOffset + innerLength,
  });

  if (command.type === 'inline') {
    const fallbackByStyle = {
      bold: 'bold text',
      italic: 'italic text',
      code: 'code',
    };
    const markerByStyle = {
      bold: '**',
      italic: '*',
      code: '`',
    };
    const innerText = selectedText || fallbackByStyle[command.style];
    const marker = markerByStyle[command.style];
    return insert(`${marker}${innerText}${marker}`, marker.length, innerText.length);
  }

  if (command.type === 'insert') {
    if (command.style === 'divider') {
      const prefix = selectionStart > 0 && !markdown.slice(0, selectionStart).endsWith('\n\n') ? '\n\n' : '';
      const suffix = markdown.slice(selectionEnd).startsWith('\n\n') ? '' : '\n\n';
      return insert(`${prefix}---${suffix}`, prefix.length, 3);
    }

    if (command.style === 'link') {
      const label = selectedText || 'Link text';
      return insert(`[${label}](${command.url})`, 1, label.length);
    }

    const altText = selectedText || 'Image alt';
    return insert(`![${altText}](${command.url})`, 2, altText.length);
  }

  if (command.type === 'block') {
    if (command.style === 'code-block') {
      const codeText = selectedText || 'Code block';
      return insert(`\`\`\`\n${codeText}\n\`\`\``, 4, codeText.length);
    }

    return transformSelectedMarkdownLines(
      markdown,
      selectionStart,
      selectionEnd,
      (line) => {
        const plainLine = stripBlockSyntax(line).trimStart();
        const leadingWhitespace = line.match(/^\s*/)?.[0] || '';

        if (command.style === 'paragraph') return `${leadingWhitespace}${plainLine}`;
        if (command.style === 'quote') return `${leadingWhitespace}> ${plainLine || 'Quote'}`;

        const level = command.style === 'heading1' ? 1 : command.style === 'heading2' ? 2 : 3;
        return `${leadingWhitespace}${'#'.repeat(level)} ${plainLine || `Heading ${level}`}`;
      },
      command.style === 'quote' ? '> Quote' : command.style === 'paragraph' ? 'Paragraph' : `${'#'.repeat(command.style === 'heading1' ? 1 : command.style === 'heading2' ? 2 : 3)} Heading`,
    );
  }

  return transformSelectedMarkdownLines(
    markdown,
    selectionStart,
    selectionEnd,
    (line, index) => {
      const plainLine = stripBlockSyntax(line).trimStart() || (command.style === 'task' ? 'Task' : 'List item');
      const leadingWhitespace = line.match(/^\s*/)?.[0] || '';

      if (command.style === 'numbered') return `${leadingWhitespace}${index + 1}. ${plainLine}`;
      if (command.style === 'task') return `${leadingWhitespace}- [ ] ${plainLine}`;
      return `${leadingWhitespace}- ${plainLine}`;
    },
    command.style === 'numbered' ? '1. List item' : command.style === 'task' ? '- [ ] Task' : '- List item',
  );
}

function applyMarkdownCommandToRenderedText(markdown: string, selectedText: string, command: MarkdownCommand) {
  if (selectedText.trim()) {
    const selectedTextStart = markdown.indexOf(selectedText);
    if (selectedTextStart >= 0) {
      return applyMarkdownCommandToText(
        markdown,
        selectedTextStart,
        selectedTextStart + selectedText.length,
        command,
      );
    }
  }

  const separator = markdown.trim()
    ? markdown.endsWith('\n\n')
      ? ''
      : markdown.endsWith('\n')
        ? '\n'
        : '\n\n'
    : '';
  const markdownWithInsertionPoint = `${markdown}${separator}`;

  return applyMarkdownCommandToText(
    markdownWithInsertionPoint,
    markdownWithInsertionPoint.length,
    markdownWithInsertionPoint.length,
    command,
  );
}

function toggleTaskInMarkdown(markdown: string, taskIndex: number, checked: boolean): string {
  let currentTaskIndex = -1;

  return markdown
    .split('\n')
    .map((line) => {
      const match = TASK_MARKDOWN_LINE_PATTERN.exec(line);
      if (!match) return line;

      currentTaskIndex += 1;
      if (currentTaskIndex !== taskIndex) return line;

      return `${match[1]}${checked ? 'x' : ' '}${match[3]}`;
    })
    .join('\n');
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
  if (tagName === 'img') {
    const source = node.getAttribute('src');
    if (!source) return '';

    return `![${node.getAttribute('alt') || 'Image'}](${source})`;
  }

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
      const taskCheckbox = clone.querySelector<HTMLInputElement>('input[data-markdown-task="true"]');

      nestedLists.forEach(list => list.remove());
      taskCheckbox?.remove();
      const marker = ordered ? `${index + 1}.` : '-';
      const taskMarker = taskCheckbox ? `[${taskCheckbox.checked ? 'x' : ' '}] ` : '';
      const itemMarkdown = serializeInlineChildren(clone).replace(/\n+/g, ' ').trim() || ' ';
      const nestedMarkdown = nestedLists.map(list => serializeList(list, depth + 1)).filter(Boolean).join('\n');

      return [`${indent}${marker} ${taskMarker}${itemMarkdown}`, nestedMarkdown].filter(Boolean).join('\n');
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
  onEditorFocus?: () => void;
}

interface MarkdownContentProps {
  markdown: string;
  onTaskToggle?: (taskIndex: number, checked: boolean) => void;
}

function MarkdownContent({ markdown, onTaskToggle }: MarkdownContentProps) {
  const taskIndexRef = useRef(0);
  taskIndexRef.current = 0;

  const components: Components = {
    a({ children, ...props }) {
      const { node, ...anchorProps } = props;
      void node;

      return (
        <a
          {...anchorProps}
          onClick={(event) => event.preventDefault()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {children}
        </a>
      );
    },
    img({ alt, ...props }) {
      const { node, ...imageProps } = props;
      void node;

      return <img {...imageProps} alt={alt || ''} contentEditable={false} />;
    },
    li({ children, ...props }) {
      const { node, ...listItemProps } = props;
      void node;
      const text = getTextFromReactNode(children).trim();
      const taskMatch = TASK_ITEM_PREFIX_PATTERN.exec(text);

      if (!taskMatch) {
        return <li {...listItemProps}>{children}</li>;
      }

      const taskIndex = taskIndexRef.current;
      taskIndexRef.current += 1;
      const checked = taskMatch[1].toLowerCase() === 'x';
      const label = taskMatch[2].trim();

      return (
        <li {...listItemProps} className="stormdance-task-list-item">
          <input
            key={`${taskIndex}-${checked ? 'checked' : 'unchecked'}`}
            type="checkbox"
            defaultChecked={checked}
            aria-label={`Toggle task ${label || taskIndex + 1}`}
            data-markdown-task="true"
            contentEditable={false}
            onChange={(event) => onTaskToggle?.(taskIndex, event.currentTarget.checked)}
          />
          <span>{label}</span>
        </li>
      );
    },
  };

  return <ReactMarkdown components={components}>{markdown}</ReactMarkdown>;
}

const RichMarkdownEditor = React.memo(forwardRef<RichMarkdownEditorHandle, RichMarkdownEditorProps>(function RichMarkdownEditor(
  { markdown, onMarkdownInput, onMarkdownCommit, onEditorFocus },
  ref,
) {
  const editorRef = useRef<HTMLElement>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const selectionTextRef = useRef('');
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

  const captureSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (isNodeInsideElement(range.commonAncestorContainer, editor)) {
      selectionRangeRef.current = range.cloneRange();
      selectionTextRef.current = selection.toString();
    }
  };

  const getEditorSelectedText = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();

    if (editor && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (isNodeInsideElement(range.commonAncestorContainer, editor)) {
        return selection.toString();
      }
    }

    return selectionTextRef.current;
  };

  const restoreEditorSelection = () => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;

    const savedRange = selectionRangeRef.current;
    if (savedRange && isNodeInsideElement(savedRange.commonAncestorContainer, editor)) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const syncFromEditorDom = (rerender = false) => {
    if (!editorRef.current) return;

    const nextMarkdown = serializeMarkdownDocument(editorRef.current);
    lastSyncedMarkdownRef.current = nextMarkdown;
    latestMarkdownRef.current = nextMarkdown;
    onMarkdownInput(nextMarkdown);

    if (rerender) setRenderedMarkdown(nextMarkdown);

    return nextMarkdown;
  };

  const handleInput = () => {
    syncFromEditorDom();
    captureSelection();
  };

  const handleFocus = () => {
    onEditorFocus?.();
    captureSelection();
  };

  const handleBlur = () => {
    if (!editorRef.current) return;

    const nextMarkdown = latestMarkdownRef.current || serializeMarkdownDocument(editorRef.current);
    lastSyncedMarkdownRef.current = nextMarkdown;
    latestMarkdownRef.current = nextMarkdown;
    setRenderedMarkdown(nextMarkdown);
  };

  const applyCommand = (command: MarkdownCommand) => {
    const editor = editorRef.current;
    if (!editor) return;

    const selectedText = getEditorSelectedText();
    const currentMarkdown = serializeMarkdownDocument(editor) || latestMarkdownRef.current || markdown;
    const nextEdit = applyMarkdownCommandToRenderedText(currentMarkdown, selectedText, command);

    lastSyncedMarkdownRef.current = nextEdit.markdown;
    latestMarkdownRef.current = nextEdit.markdown;
    setRenderedMarkdown(nextEdit.markdown);
    onMarkdownInput(nextEdit.markdown);

    window.requestAnimationFrame(() => {
      restoreEditorSelection();
      captureSelection();
    });
  };

  useImperativeHandle(ref, () => ({ applyCommand }));

  const handleTaskToggle = (taskIndex: number, checked: boolean) => {
    const nextMarkdown = toggleTaskInMarkdown(latestMarkdownRef.current || markdown, taskIndex, checked);
    lastSyncedMarkdownRef.current = nextMarkdown;
    latestMarkdownRef.current = nextMarkdown;
    setRenderedMarkdown(nextMarkdown);
    onMarkdownInput(nextMarkdown);
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
      onFocus={handleFocus}
      onKeyUp={captureSelection}
      onMouseUp={captureSelection}
    >
      {markdownForRender.trim() ? <MarkdownContent markdown={markdownForRender} onTaskToggle={handleTaskToggle} /> : null}
    </article>
  );
}), (previousProps, nextProps) => {
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    const focusedMarkdownEditor = document.activeElement.closest('[data-markdown-editor="true"]');
    if (focusedMarkdownEditor) return true;
  }

  return previousProps.markdown === nextProps.markdown;
});

interface MarkdownToolbarProps {
  onCommand: (command: MarkdownCommand) => void;
}

function MarkdownToolbar({ onCommand }: MarkdownToolbarProps) {
  const [urlTool, setUrlTool] = useState<'link' | 'image' | null>(null);
  const [urlValue, setUrlValue] = useState('');

  const openUrlTool = (tool: 'link' | 'image') => {
    setUrlTool(tool);
    setUrlValue('');
  };

  const closeUrlTool = () => {
    setUrlTool(null);
    setUrlValue('');
  };

  const submitUrlTool = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = urlValue.trim();
    if (!urlTool || !url) return;

    onCommand({ type: 'insert', style: urlTool, url });
    closeUrlTool();
  };

  const toolbarButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded border border-transparent text-gray-600 transition-colors hover:border-gray-200 hover:bg-white hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:bg-gray-900 dark:hover:text-gray-50';

  return (
    <div className="stormdance-markdown-toolbar border-b border-gray-200 bg-gray-50/95 px-2 py-2 dark:border-gray-800 dark:bg-gray-900/80">
      <div
        className="flex flex-wrap items-center gap-1"
        role="toolbar"
        aria-label="Markdown formatting toolbar"
      >
        <label className="inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300">
          <Pilcrow className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">Block style</span>
          <select
            defaultValue="paragraph"
            aria-label="Markdown block style"
            title="Block style"
            onChange={(event) => onCommand({ type: 'block', style: event.currentTarget.value as MarkdownBlockStyle })}
            className="h-8 bg-transparent text-xs focus:outline-none"
          >
            {BLOCK_STYLES.map(style => (
              <option key={style.value} value={style.value}>
                {style.label}
              </option>
            ))}
          </select>
        </label>

        <div className="mx-1 h-6 w-px bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

        {INLINE_TOOLBAR_ITEMS.map(({ label, title, Icon, command }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand(command)}
            className={toolbarButtonClass}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        ))}

        <button
          type="button"
          aria-label="Insert link"
          title="Insert link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openUrlTool('link')}
          className={toolbarButtonClass}
        >
          <Link className="h-4 w-4" aria-hidden="true" />
        </button>

        <button
          type="button"
          aria-label="Insert image"
          title="Insert image"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openUrlTool('image')}
          className={toolbarButtonClass}
        >
          <Image className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="mx-1 h-6 w-px bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

        {LIST_TOOLBAR_ITEMS.map(({ label, title, Icon, command }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand(command)}
            className={toolbarButtonClass}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        ))}

        <button
          type="button"
          aria-label="Quote"
          title="Quote"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommand({ type: 'block', style: 'quote' })}
          className={toolbarButtonClass}
        >
          <Quote className="h-4 w-4" aria-hidden="true" />
        </button>

        <button
          type="button"
          aria-label="Horizontal rule"
          title="Horizontal rule"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommand({ type: 'insert', style: 'divider' })}
          className={toolbarButtonClass}
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="ml-auto hidden items-center gap-1 md:flex" aria-hidden="true">
          <Heading1 className="h-3.5 w-3.5 text-gray-400" />
          <Heading2 className="h-3.5 w-3.5 text-gray-400" />
          <Heading3 className="h-3.5 w-3.5 text-gray-400" />
        </div>
      </div>

      {urlTool && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          aria-label={urlTool === 'link' ? 'Insert link URL' : 'Insert image URL'}
          onSubmit={submitUrlTool}
        >
          <input
            type="url"
            value={urlValue}
            onChange={(event) => setUrlValue(event.currentTarget.value)}
            placeholder={urlTool === 'link' ? 'https://example.com' : 'https://example.com/image.png'}
            aria-label={urlTool === 'link' ? 'Link URL' : 'Image URL'}
            className="h-8 min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 text-sm text-gray-900 focus:border-yellow-400 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            autoFocus
          />
          <button
            type="submit"
            className="h-8 rounded bg-yellow-400 px-3 text-xs font-semibold text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
          >
            Insert
          </button>
          <button
            type="button"
            onClick={closeUrlTool}
            className="h-8 rounded px-3 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

export function Editor({ note, onUpdateNote, titleInputRef, textAreaRef }: EditorProps) {
  const [editorMode, setEditorMode] = useState<EditorMode>(getInitialEditorMode);
  const [content, setContent] = useState(note?.content || '');
  const contentRef = useRef(note?.content || '');
  const currentNoteIdRef = useRef(note?.id || null);
  const richMarkdownEditorRef = useRef<RichMarkdownEditorHandle>(null);
  const lastMarkdownSurfaceRef = useRef<'source' | 'rich'>('rich');
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
  };

  const handleContentInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    lastRichInputMarkdownRef.current = null;
    lastMarkdownSurfaceRef.current = 'source';
    updateContent(e.currentTarget.value);
  };

  const rememberSourceSelection = () => {
    const textArea = textAreaRef.current;
    if (!textArea) return;

    lastMarkdownSurfaceRef.current = 'source';
  };

  const handleMarkdownToolbarCommand = (command: MarkdownCommand) => {
    const textArea = textAreaRef.current;
    const shouldUseSourceTextarea = editorMode === 'split' && textArea && lastMarkdownSurfaceRef.current === 'source';

    if (shouldUseSourceTextarea && textArea) {
      const activeSelection = {
        start: textArea.selectionStart,
        end: textArea.selectionEnd,
      };
      const edit = applyMarkdownCommandToText(
        textArea.value,
        activeSelection.start,
        activeSelection.end,
        command,
      );
      lastRichInputMarkdownRef.current = null;
      updateContent(edit.markdown);

      window.requestAnimationFrame(() => {
        textArea.focus();
        textArea.selectionStart = edit.selectionStart;
        textArea.selectionEnd = edit.selectionEnd;
      });
      return;
    }

    lastMarkdownSurfaceRef.current = 'rich';
    richMarkdownEditorRef.current?.applyCommand(command);
  };

  const handleEditorModeChange = (nextMode: EditorMode) => {
    if ((editorMode === 'markdown' || editorMode === 'split') && nextMode !== editorMode) {
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
  const showRichMarkdownEditor = editorMode === 'split' || editorMode === 'markdown';
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
        {showRichMarkdownEditor && (
          <MarkdownToolbar onCommand={handleMarkdownToolbarCommand} />
        )}
        <div className={`min-h-0 flex-1 ${editorBodyLayout}`}>
          {showTextEditor && (
            <div className={`min-h-0 min-w-0 flex-1 ${editorPaneClass}`}>
              <textarea
                ref={textAreaRef}
                defaultValue={content}
                onInput={handleContentInput}
                onFocus={rememberSourceSelection}
                onKeyUp={rememberSourceSelection}
                onMouseUp={rememberSourceSelection}
                onSelect={rememberSourceSelection}
                placeholder="Start writing your note..."
                aria-label={editorMode === 'text' ? 'Note content' : 'Note markdown source'}
                className="h-full min-h-0 w-full resize-none bg-transparent p-3 focus:outline-none dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
              />
            </div>
          )}

          {showRichMarkdownEditor && (
            <RichMarkdownEditor
              ref={richMarkdownEditorRef}
              key={note.id}
              markdown={content}
              onMarkdownInput={handleRichMarkdownInput}
              onMarkdownCommit={handleRichMarkdownCommit}
              onEditorFocus={() => {
                lastMarkdownSurfaceRef.current = 'rich';
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
