export type MarkdownBlockStyle = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'quote' | 'code-block';

export type MarkdownCommand =
  | { type: 'block'; style: MarkdownBlockStyle }
  | { type: 'inline'; style: 'bold' | 'italic' | 'code' }
  | { type: 'list'; style: 'bullet' | 'numbered' | 'task' }
  | { type: 'insert'; style: 'link' | 'image'; url: string }
  | { type: 'insert'; style: 'divider' };

const TASK_MARKDOWN_LINE_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+.*)$/;

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

export function applyMarkdownCommandToText(
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

export function applyMarkdownCommandToRenderedText(
  markdown: string,
  selectedText: string,
  command: MarkdownCommand,
) {
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

export function toggleTaskInMarkdown(markdown: string, taskIndex: number, checked: boolean): string {
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
