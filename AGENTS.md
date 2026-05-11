# AGENTS.md

## Self-Improvement Directive
When working on this project, update this file whenever you learn something durable that will help the next agent. Capture working commands, failed experiments, project conventions, local pitfalls, collaborator preferences, and responsibilities while the details are fresh. Keep notes concrete and prune stale guidance when it becomes misleading.

## Responsibilities
- Preserve local-first note editing as the reliable core workflow.
- Fix Dependabot, npm audit, code scanning, and secret scanning findings whenever they are observed while working in the repo; do not treat them as optional follow-up unless a fix is blocked or unsafe.
- Keep `FEATURES.md` current when shipped behavior, stability, or test criteria change.
- Add or update tests when changing user-visible behavior.
- Commit and push completed changes so the repository keeps history.

## Setup Commands
- Install deps: `npm ci`
- Build: `npm run build`
- Dev server: `npm run dev`
- Unit tests: `npm test`
- End-to-end tests: `npm run test:e2e`
- Update Playwright snapshots intentionally: `npm run test:e2e:update`
- Install Playwright-managed browsers when needed: `npm run test:e2e:install`

## Workflow
- **Always** commit and push changes after every update or significant step.
- Before each push with app changes, bump `package.json` and `package-lock.json` version so the app info dialog reflects the new release.
- Start by checking `git status --short --branch`.
- Read this file and `FEATURES.md` before significant implementation work.
- Keep unrelated changes separate; do not revert user changes unless explicitly asked.
- Prefer CLI workflows that can be repeated and committed.
- Record useful lessons in this file or in a more focused project document before committing.

## Project Overview
- Vite + React + TypeScript notes app.
- Tailwind CSS provides styling; `lucide-react` provides icons.
- IndexedDB through `idb` is the local persistence layer.
- `FEATURES.md` is the canonical feature inventory and stability/testability map.

## Documentation
- When adding, removing, or modifying product capabilities, update `FEATURES.md` to keep the documented feature set in sync with the implementation and history.

## CI/CD & Deployment
- **Workflows**:
    - `build.yml`: Runs on PRs and pushes to main. Verifies the build.
    - `deploy.yml`: Runs on pushes to `main`. Builds and deploys to GitHub Pages.
- **Deployment Process**:
    1. Code is pushed to `main`.
    2. `deploy.yml` triggers.
    3. Builds the project (`npm run build`).
    4. Uploads `dist/` artifact.
    5. Deploys to GitHub Pages environment.
- **Custom Domain**:
    - If using a custom domain (e.g., `storm.dance`), ensure a `CNAME` file exists in `public/` or is configured in GitHub Pages settings.
    - If NOT using a custom domain (e.g., `user.github.io/repo`), update `base` in `vite.config.ts` to `'/repo-name/'`.
- **Troubleshooting**:
    - Check the "Actions" tab in GitHub for workflow run status.
    - Keep workflow Actions on current non-deprecated major versions. As of 2026-05-11, that means `actions/checkout@v6`, `actions/setup-node@v6`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`, and `actions/upload-artifact@v7`.
    - Before changing workflow Action majors, verify current official releases with `gh release list --repo actions/<action-name> --limit 5`.
    - `tsc -b` cannot be used with `--skipLibCheck`.

## Playwright
- E2E specs live in `e2e/`.
- Tests mock IPFS endpoint checks so the app shell remains deterministic and local note behavior is not blocked by network state.
- The Playwright config uses system Chrome at `/usr/bin/google-chrome` when present; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to override.
- Snapshot updates should be deliberate and reviewed with the related UX change.
- In sandboxed agent environments, Playwright may need network approval because Vite binds `127.0.0.1:5173` and Chrome launches outside a pure file-only flow.

## XMTP
- **SDK**: Use `@xmtp/browser-sdk` (v5+). Do NOT use `@xmtp/xmtp-js`.
- **Connection**: Use `Client.create(signer, { env })`.
    - `signer` must be adapted to the SDK's `Signer` interface (requires `type`, `getIdentifier`, `signMessage`).
    - `enableV3` is implicit/default in v5 (or handled via capabilities).
- **Conversations**:
    - Use `client.conversations.newDmWithIdentifier(identifier)` for DMs.
    - `identifier` should be `{ identifierKind: 'Ethereum', identifier: address }`.
- **Vite Config**: Do **NOT** alias `@xmtp/browser-sdk` to a local file (e.g., `src/lib/xmtp-browser-sdk.ts`) as it causes circular dependencies.
- **Reference**: [XMTP LLM Chat Apps](https://raw.githubusercontent.com/xmtp/docs-xmtp-org/main/llms/llms-chat-apps.txt)

## Tech Stack Quirks
- This is a Vite + React project.
- Uses Tailwind CSS for styling.
- Uses `lucide-react` for icons.
- `FEATURES.md` replaced the old `TECHNOLOGY.md`; put feature specs and technology constraints there.
- `vite.config.ts` defines `__APP_VERSION__` from `package.json` and `__APP_BUILD_TIME__` from the current build timestamp for the top-bar app info dialog.
- `vite.config.ts` also defines `__APP_COMMIT_SHA__` and `__APP_COMMIT_URL__`, using GitHub Actions environment values when available and local git metadata otherwise.

## Known Issues & Solutions
- `npm install` may fail in sandboxed environments with `EAI_AGAIN`; rerun with network approval when dependency downloads are required.
- The app performs IPFS reachability checks on load. Tests should mock those requests unless the test is specifically about live IPFS connectivity.
- Browser automation can edit note fields without emitting React `onChange`; note saves should use `input` events as the canonical trigger, and direct automation can use `window.stormdance.setNoteContent(noteId, content)` or related helpers.
- Rapid title/content edits can race through IndexedDB if saves are allowed to overlap. Preserve the per-note update queue and local merge behavior in `App.tsx` when changing note persistence.
- Markdown and split rendered panes use a lightweight `contenteditable` rendered document plus DOM-to-Markdown serialization for common structures. Avoid assuming it has the full fidelity of a ProseMirror/TipTap/MDXEditor-style editor unless one of those engines is introduced deliberately.
- Markdown and split modes share a formatting toolbar. Toolbar actions should update the canonical Markdown text, whether the user last focused the split source textarea or the rendered rich editor.
- Task list checkboxes are implemented by recognizing Markdown list items that start with `[ ]` or `[x]`; checkbox toggles must update the source Markdown line, not only the rendered input state.
- `npm run lint` currently reports pre-existing app-wide lint debt. Run targeted ESLint on files you touch, and keep broad cleanup separate from feature work.
