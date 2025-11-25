# Technology Stack

## Core
- **Framework**: React 18
- **Build Tool**: Vite 6
- **Language**: TypeScript 5.6

## Styling
- **CSS Framework**: Tailwind CSS 3.4
- **Icons**: Lucide React
- **Components**: Radix UI (Primitives), Shadcn UI (Implementation patterns)
- **Animations**: Tailwindcss-animate

## State & Data
- **Local Database**: IDB (IndexedDB wrapper)
- **Forms**: React Hook Form + Zod
- **Date Handling**: Date-fns

## Web3 & Messaging
- **Messaging**: XMTP Browser SDK v5.0.1
- **Ethereum**: Ethers.js v6
- **Polyfills**: vite-plugin-node-polyfills (buffer, crypto, stream)

## UX Patterns & Quirks

### Inline Action Buttons
Implementing inline action buttons (Edit, Delete, Info) within a clickable list item (like a notebook selection row) presents specific challenges:

1.  **Event Propagation**:
    *   **Challenge**: Clicking an action button inside a clickable row will bubble the event up, triggering the row selection logic.
    *   **Solution**: Must use `e.stopPropagation()` and `e.preventDefault()` on `onClick`. Crucially, `onMouseDown={(e) => e.stopPropagation()}` is often required because some selection logic triggers on mouse down, or focus shifts happen before the click event fires.

2.  **Layout & Positioning**:
    *   **Challenge**: Absolute positioning is often used to overlay buttons on the right side of the row. However, this removes the buttons from the document flow, leading to potential overlap with long text or other elements if not carefully managed.
    *   **Constraint**: Flex containers with `gap` do not apply to absolutely positioned children in the standard way.
    *   **Solution**:
        *   Ensure the container has a defined width or `w-auto` if using flex gap.
        *   Use `z-index` to ensure buttons sit above text.
        *   Consider reserving space in the row (padding-right) so text doesn't flow under the buttons.

3.  **Visibility States**:
    *   **Pattern**: Buttons should be visible on **Hover** OR when **Selected**.
    *   **Implementation**: Use CSS classes like `opacity-0 group-hover:opacity-100` combined with conditional rendering or conditional classes based on selection state (e.g., `selected ? 'opacity-100' : ''`).

4.  **Mobile Considerations**:
    *   **Challenge**: Hover states don't exist on touch devices.
    *   **Solution**:
        *   **Selected State**: Tapping a row selects it, which should reveal the actions. This is the primary pattern we use.
        *   **Touch Targets**: Ensure buttons are at least 44x44px (or close to it with padding) for touchability.
        *   **Swipe Actions**: A common mobile pattern, but complex to implement in a web sidebar. We stick to "Select to Reveal".
        *   **Thumb Zone**: Keep actions easy to reach. In our sidebar, right-aligned icons work well for right-handed users but must not overlap text.

### Sidebar Navigation
- **Structure**: The sidebar uses a flexible layout with a fixed width on desktop and a drawer/sheet pattern on mobile.
- **Scroll Areas**: `react-scroll-area` (Radix) is used to ensure custom scrollbar styling across browsers.

### Keyboard Navigation
- **Column Cycling**: Pressing `Tab` while focused on a column container (not inside an input/textarea/button) cycles focus across the Notebooks → Notes → Editor columns. This avoids hijacking `Tab` when users are typing or interacting with controls, keeping native form navigation intact.
- **Focus Guards**: Editable surfaces (`input`, `textarea`, `select`, `button`, and `contenteditable`) bypass the custom handler so users can tab through form controls as expected.

### Import Formats
- Backup imports accept both encrypted (`.json.encrypted`) and plain JSON (`.json`) files. The file picker and validation surface a clear error if another extension is chosen.
