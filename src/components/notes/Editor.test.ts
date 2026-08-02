import { describe, expect, it } from 'vitest';
import {
  applyMarkdownCommandToText,
  toggleTaskInMarkdown,
} from './markdownCommands';

describe('source Markdown commands', () => {
  it('applies a heading to the canonical selected line', () => {
    expect(applyMarkdownCommandToText(
      'Toolbar text',
      0,
      'Toolbar text'.length,
      { type: 'block', style: 'heading2' },
    )).toEqual({
      markdown: '## Toolbar text',
      selectionStart: 0,
      selectionEnd: '## Toolbar text'.length,
    });
  });

  it('inserts a task on the empty line at the source cursor', () => {
    const markdown = '## **Toolbar text**\n';

    expect(applyMarkdownCommandToText(
      markdown,
      markdown.length,
      markdown.length,
      { type: 'list', style: 'task' },
    ).markdown).toBe('## **Toolbar text**\n- [ ] Task');
  });
});

describe('task Markdown toggles', () => {
  it('updates only the selected task marker', () => {
    const markdown = '- [ ] Write tests\n- [x] Ship fix';

    expect(toggleTaskInMarkdown(markdown, 0, true)).toBe(
      '- [x] Write tests\n- [x] Ship fix',
    );
    expect(toggleTaskInMarkdown(markdown, 1, false)).toBe(
      '- [ ] Write tests\n- [ ] Ship fix',
    );
  });
});
