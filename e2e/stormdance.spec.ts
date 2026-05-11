import { expect, test, type Page } from '@playwright/test';

async function openApp(page: Page) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (
      url.includes('localhost:5001') ||
      url.includes('127.0.0.1:5001') ||
      url.includes('ipfs.io') ||
      url.includes('corsproxy.io')
    ) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }

    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'storm.dance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notebooks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Stormdance workspace');
  await expect(page.getByRole('button', { name: 'Import notebook backup' })).toBeVisible();
  await expect(page.getByText('IPFS Offline')).toBeVisible({ timeout: 10_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - window.innerWidth,
    document: document.documentElement.scrollWidth - window.innerWidth,
  }));

  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
}

async function expectStoredNote(page: Page, title: string, content: string) {
  await page.waitForFunction(
    ({ expectedTitle, expectedContent }) =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('storm.dance');
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('notes', 'readonly');
          const getAll = tx.objectStore('notes').getAll();
          getAll.onerror = () => {
            db.close();
            resolve(false);
          };
          getAll.onsuccess = () => {
            const notes = getAll.result as Array<{ title?: string; content?: string }>;
            db.close();
            resolve(notes.some((note) => note.title === expectedTitle && note.content === expectedContent));
          };
        };
      }),
    { expectedTitle: title, expectedContent: content },
  );
}

async function expectTextareaReachesPageBottom(page: Page) {
  const bottomGap = await page.getByPlaceholder('Start writing your note...').evaluate((textarea) => {
    const rect = textarea.getBoundingClientRect();
    return window.innerHeight - rect.bottom;
  });

  expect(bottomGap).toBeLessThanOrEqual(72);
}

test.describe('storm.dance notes', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies();
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('stormdance.e2e.localStorageReady')) {
        window.localStorage.clear();
        window.sessionStorage.setItem('stormdance.e2e.localStorageReady', 'true');
      }
      window.localStorage.setItem('theme', 'light');
    });
  });

  test('creates, edits, persists, reopens, and deletes a note', async ({ page }) => {
    await openApp(page);

    const createNote = page.getByRole('button', { name: 'Create new note', exact: true });
    await expect(createNote).toBeEnabled();
    await expect(createNote).toHaveAttribute('aria-keyshortcuts', 'Control+Alt+N Meta+Alt+N');
    await page.keyboard.press('Control+Alt+N');

    const title = page.getByPlaceholder('Note Title');
    const content = page.getByPlaceholder('Start writing your note...');
    await expect(title).toBeVisible();
    await title.fill('E2E Note');
    await content.fill('Line one\nLine two');

    const noteButton = page.getByRole('treeitem', { name: 'Note E2E Note' });
    await expect(noteButton).toBeVisible();
    await expect(noteButton).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('status')).toContainText('Selected note: E2E Note.');
    await expect(content).toHaveValue('Line one\nLine two');
    await expectTextareaReachesPageBottom(page);
    await expectStoredNote(page, 'E2E Note', 'Line one\nLine two');

    const inputEventContent = 'Saved by a raw input event';
    await content.evaluate((textarea, nextContent) => {
      textarea.value = nextContent;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, inputEventContent);
    await expect(content).toHaveValue(inputEventContent);
    await expectStoredNote(page, 'E2E Note', inputEventContent);

    const noteId = await page.evaluate(() => {
      const api = (window as Window & {
        stormdance?: { getWorkspaceState: () => { activeNoteId: string | null } };
      }).stormdance;
      return api?.getWorkspaceState().activeNoteId ?? null;
    });
    expect(noteId).not.toBeNull();

    const programmaticContent = 'Saved by window.stormdance.setNoteContent';
    await page.evaluate(
      async ({ targetNoteId, nextContent }) => {
        const api = (window as Window & {
          stormdance?: { setNoteContent: (noteId: string, content: string) => Promise<unknown> };
        }).stormdance;
        if (!api) throw new Error('window.stormdance API is not available');
        await api.setNoteContent(targetNoteId, nextContent);
      },
      { targetNoteId: noteId!, nextContent: programmaticContent },
    );
    await expect(content).toHaveValue(programmaticContent);
    await expectStoredNote(page, 'E2E Note', programmaticContent);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'storm.dance' })).toBeVisible();
    await expect(noteButton).toBeVisible();
    await expect(noteButton).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Open note E2E Note' })).toHaveAttribute('aria-selected', 'true');

    await expect(title).toHaveValue('E2E Note');
    await expect(content).toHaveValue(programmaticContent);

    await noteButton.hover();
    await page.getByLabel('Delete note E2E Note').click();
    await expect(page.getByText('No notes or folders yet')).toBeVisible();
    await expect(noteButton).toHaveCount(0);
  });

  test('supports notebook and folder creation without breaking navigation', async ({ page }) => {
    await openApp(page);

    await page.getByRole('button', { name: 'Create new notebook', exact: true }).click();
    await page.getByLabel('Notebook Name').fill('Field Notes');
    await page.getByRole('button', { name: 'Create Notebook' }).click();

    await expect(page.getByText('Notebook "Field Notes" created')).toBeVisible();
    const selectedNotebook = page.getByRole('option', { name: /Notebook Field Notes, selected/ });
    await expect(selectedNotebook).toBeVisible();
    await expect(selectedNotebook).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: 'Create new root folder', exact: true }).click();
    await page.getByPlaceholder('Folder name').fill('Research');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page.getByLabel('Expand Research')).toBeVisible();
    await page.getByLabel('Expand Research').click();
    await expect(page.getByLabel('Collapse Research')).toBeVisible();
  });
});

test.describe('storm.dance UX smoke checks', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies();
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('stormdance.e2e.localStorageReady')) {
        window.localStorage.clear();
        window.sessionStorage.setItem('stormdance.e2e.localStorageReady', 'true');
      }
      window.localStorage.setItem('theme', 'light');
    });
  });

  test('keeps the app shell stable on desktop and mobile', async ({ page }) => {
    await openApp(page);

    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot('app-shell-desktop.png', {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'storm.dance' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notebooks' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const notebookPanel = await page.getByRole('heading', { name: 'Notebooks' }).boundingBox();
    const emptyEditor = await page.getByText('Select a note to open it.').boundingBox();
    expect(notebookPanel).not.toBeNull();
    expect(emptyEditor).not.toBeNull();
    expect(emptyEditor!.y).toBeGreaterThan(notebookPanel!.y);

    await expect(page).toHaveScreenshot('app-shell-mobile.png', {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });

  test('theme toggle exposes the expected state change', async ({ page }) => {
    await openApp(page);

    const themeToggle = page.getByRole('button', { name: 'Switch to dark mode' });
    await expect(themeToggle).toBeVisible();
    await themeToggle.click();

    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
  });

  test('exposes browser-safe Obsidian hotkeys from the top bar', async ({ page }) => {
    await openApp(page);

    await page.getByRole('button', { name: 'Show browser-safe Obsidian hotkeys' }).click();
    const hotkeys = page.getByRole('region', { name: 'Browser-safe Obsidian hotkeys' });

    await expect(hotkeys).toBeVisible();
    await expect(hotkeys).toContainText('Ctrl+Alt+N');
    await expect(hotkeys).toContainText('Ctrl+Alt+1 / 2 / 3');
  });
});
