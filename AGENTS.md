# AGENTS.md

## Setup commands
- Install deps: `npm ci`
- Build: `npm run build`
- Dev server: `npm run dev`

## Workflow
- **Always** commit and push changes after every update or significant step.

## Documentation
- When adding, removing, or modifying product capabilities, update `FEATURES.md` to keep the documented feature set in sync with the implementation and history.

## CI/CD & Deployment
- **Workflows**:
    - `build.yml`: Runs on PRs and pushes to main. Verifies the build.
    - `deploy.yml`: Runs on pushes to `main`. Builds and deploys to GitHub Pages.
- **Deployment Process**:
    1.  Code is pushed to `main`.
    2.  `deploy.yml` triggers.
    3.  Builds the project (`npm run build`).
    4.  Uploads `dist/` artifact.
    5.  Deploys to GitHub Pages environment.
- **Custom Domain**:
    - If using a custom domain (e.g., `storm.dance`), ensure a `CNAME` file exists in `public/` or is configured in GitHub Pages settings.
    - If NOT using a custom domain (e.g., `user.github.io/repo`), update `base` in `vite.config.ts` to `'/repo-name/'`.
- **Troubleshooting**:
    - Check the "Actions" tab in GitHub for workflow run status.
    - Ensure `actions/upload-pages-artifact@v4` and `actions/deploy-pages@v4` are used.
    - `tsc -b` cannot be used with `--skipLibCheck`.

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
