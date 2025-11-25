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
- Always enforce XMTP v3 by passing `enableV3: true` to `Client.create`.
- Note: `enableV3` might not be in the type definitions yet, so use `// @ts-expect-error` if needed.
- Use `XmtpConnectionModal` for connection UI.

## Tech Stack Quirks
- This is a Vite + React project.
- Uses Tailwind CSS for styling.
- Uses `lucide-react` for icons.
