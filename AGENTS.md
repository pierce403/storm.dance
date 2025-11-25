# AGENTS.md

## Setup commands
- Install deps: `npm ci`
- Build: `npm run build`
- Dev server: `npm run dev`

## Workflow
- **Always** commit and push changes after every update or significant step.

## CI/CD
- Use `actions/upload-pages-artifact@v4` and `actions/upload-artifact@v4`.
- **Do not** use v3 of these actions as they are deprecated.
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
