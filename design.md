# DeckOS - Design Language

## Aesthetic Direction: Retro-Future Brutalist Console

DeckOS looks like the command deck of a near-future industrial spacecraft -- dense with information, deliberately raw, but precisely engineered. It takes cues from 1970s NASA mission control, Alien (1979) CRT interfaces, and brutalist architecture: exposed structure, monospaced type, hard edges, no ornament for ornament's sake. Every element earns its space.

This is not "dark mode with rounded corners." It is a **control system** that happens to be beautiful.

### Design Pillars

1. **Density over whitespace** -- Information-rich screens. Data is always visible, never hidden behind hover states or modals when it can be shown inline.
2. **Structure is ornament** -- Borders, grids, and alignment do the decorative work. No gradients, no drop shadows, no blur. The grid IS the design.
3. **Monospace authority** -- Monospaced type everywhere. It communicates precision and ties visually to the terminal/compose file workflow.
4. **Status at a glance** -- Color is reserved almost exclusively for status indication. The palette is restrained until something demands attention.
5. **Mechanical interaction** -- Clicks feel deliberate. Hover states are instant, not eased. Transitions are short (80-120ms) and linear. Nothing "bounces."

## Color Palette

```
/* Base */
--bg-primary:        #0a0a0a;     /* Near-black background */
--bg-secondary:      #141414;     /* Panel/card background */
--bg-tertiary:       #1e1e1e;     /* Elevated surfaces */
--bg-input:          #0f0f0f;     /* Input fields */

/* Borders */
--border-primary:    #2a2a2a;     /* Subtle structure lines */
--border-active:     #4a4a4a;     /* Active/focused borders */
--border-accent:     #00ff88;     /* Accent border (rare, high signal) */

/* Text */
--text-primary:      #e0e0e0;     /* Primary content */
--text-secondary:    #888888;     /* Labels, descriptions */
--text-muted:        #555555;     /* Disabled, tertiary info */
--text-inverse:      #0a0a0a;     /* Text on accent backgrounds */

/* Status -- The ONLY source of chromatic color */
--status-running:    #00ff88;     /* Green -- operational */
--status-stopped:    #ff4444;     /* Red -- stopped/error */
--status-warning:    #ffaa00;     /* Amber -- warning/pulling */
--status-info:       #00aaff;     /* Blue -- informational */
--status-neutral:    #666666;     /* Grey -- unknown/idle */

/* Accent */
--accent-primary:    #00ff88;     /* Primary interactive accent (the "power light") */
--accent-hover:      #00cc6a;     /* Hover state */
--accent-muted:      rgba(0, 255, 136, 0.1);  /* Subtle accent backgrounds */

/* Metrics */
--meter-cpu:         #00aaff;     /* CPU usage bar */
--meter-memory:      #ff6b00;     /* Memory usage bar */
--meter-disk:        #aa44ff;     /* Disk usage bar */
--meter-network:     #00ff88;     /* Network throughput */
```

### Color Rules

- The UI is nearly monochromatic (greys on black) by default
- Chromatic color appears ONLY for: status indicators, interactive accents, and metric visualizations
- The green accent (`#00ff88`) is the signature color -- it appears on the primary action button, active nav items, and the "running" status. It reads like a power indicator LED.
- Never use color as the sole indicator; always pair with text labels or icons

## Typography

```
/* Primary -- everything */
--font-mono:         'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;

/* Display -- headings, hero numbers */
--font-display:      'Space Mono', 'JetBrains Mono', monospace;
```

### Type Scale

```
--text-xs:    0.6875rem;   /* 11px - Labels, badges */
--text-sm:    0.75rem;     /* 12px - Secondary text, table cells */
--text-base:  0.8125rem;   /* 13px - Body text, inputs */
--text-md:    0.875rem;    /* 14px - Primary content */
--text-lg:    1rem;        /* 16px - Section headers */
--text-xl:    1.25rem;     /* 20px - Page headers */
--text-2xl:   1.75rem;     /* 28px - Dashboard hero numbers */
--text-3xl:   2.5rem;      /* 40px - Big metric displays */
```

- ALL text is uppercase for labels and navigation (css `text-transform: uppercase; letter-spacing: 0.08em`)
- Body/content text (descriptions, log output) remains normal case
- Letter-spacing is generous on small text (`0.05em` minimum at `--text-xs`)
- Font weight: 400 (regular) for body, 500 (medium) for labels, 700 (bold) for headings/numbers

## Layout & Grid

### Shell Structure

```
+--[TOP BAR - 48px]-------------------------------------------+
| DECKOS          [Dashboard] [Apps] [Settings]     hostname   |
+--------------------------------------------------------------+
|                                                              |
|                     MAIN CONTENT AREA                        |
|                                                              |
|              (full width, scrollable vertically)             |
|                                                              |
+--------------------------------------------------------------+
```

- **No sidebar.** A top navigation bar keeps the layout wide and horizontal, maximizing the dashboard's data density.
- Top bar: fixed, 48px height. Logo left, nav center, system info right.
- Content area: max-width 1440px, centered, with 24px horizontal padding.
- All layouts use CSS Grid. No flexbox for page-level layout (grid is more brutalist -- explicit tracks, visible structure).

### Grid System

- Base grid unit: **8px**
- All spacing is multiples of 8: 8, 16, 24, 32, 48, 64
- Panel gaps: 1px solid borders (exposed grid lines, brutalist style) or 2px gaps
- Cards/panels have NO border-radius. Everything is sharp rectangles.
- Panels use 1px borders (`--border-primary`) on all sides -- the border grid is visible and intentional

## Components

### Top Bar

- Fixed position, `height: 48px`, `background: --bg-primary`, bottom border `1px solid --border-primary`
- Left: "DECKOS" logotype in `--font-display`, `--text-lg`, `--accent-primary` color, `letter-spacing: 0.15em`
- Center: Navigation links styled as tab-like segments: `DASHBOARD | APPS | SETTINGS`. Active item has a bottom 2px border in `--accent-primary` and text in `--accent-primary`. Inactive items in `--text-secondary`.
- Right: Hostname in `--text-muted`, `--text-xs`, uppercase

### Dashboard Page

The dashboard is a dense grid of information panels:

```
+--[SYSTEM INFO BAR - full width]-----------------------------+
| HOSTNAME: skylab   OS: Ubuntu 24.04   UPTIME: 14d 6h 23m   |
| DOCKER: 27.1.2    CONTAINERS: 12 running / 2 stopped       |
+-------------------------------------------------------------+

+--[METRICS GRID - 4 columns]--------------------------------+
| ┌──CPU──────────┐ ┌──MEMORY───────┐ ┌──DISK─────────┐ ┌──NETWORK──────┐ |
| │  23%          │ │  6.2 / 16 GB  │ │  234 / 500 GB │ │  ↑ 1.2 MB/s   │ |
| │  ████░░░░░░░  │ │  ████████░░░  │ │  ██████████░  │ │  ↓ 4.8 MB/s   │ |
| │  [sparkline]  │ │  [sparkline]  │ │  [sparkline]  │ │  [sparkline]  │ |
| └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘ |
+---------------------------------------------------------------------+

+--[APP LAUNCHER GRID]-------------------------------------------+
|  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐          |
|  │  [icon] │  │  [icon] │  │  [icon] │  │  [icon] │          |
|  │ Jellyfin│  │Syncthing│  │ Pi-hole │  │Nextcloud│          |
|  │  ● RUN  │  │  ● RUN  │  │  ● STOP │  │  ● RUN  │          |
|  └─────────┘  └─────────┘  └─────────┘  └─────────┘          |
+-----------------------------------------------------------------+
```

#### Metric Cards

- Each metric is a panel with a 1px border
- Top: label in `--text-xs`, uppercase, `--text-secondary`
- Center: large number in `--text-2xl` or `--text-3xl`, `--text-primary`, bold
- Bottom: a horizontal bar meter (not rounded) showing usage. Fill color matches the metric category. Background is `--bg-tertiary`.
- Below the bar: a mini sparkline (last 60 data points) rendered with a simple SVG polyline or canvas. Stroke color matches the metric, no fill.

#### App Tiles

- Grid of square-ish tiles, `min-width: 140px`, responsive columns via `auto-fill`
- Each tile: `--bg-secondary` background, `1px solid --border-primary` border, `padding: 16px`
- Icon: 48x48, centered at top. Falls back to first letter of app name on a `--bg-tertiary` background.
- Name: centered below icon, `--text-sm`, uppercase
- Status dot: 8px circle, color from `--status-*` palette, inline with a status label in `--text-xs`
- Hover: border transitions to `--border-active`, background shifts to `--bg-tertiary`
- Entire tile is a clickable link to the app's external URL
- A small gear icon in the top-right corner (visible on hover) links to the app detail page

### Apps List Page

A table/list view of all managed apps with more detail than the dashboard tiles:

```
+--[HEADER]------------------------------------------------------+
| APPS                                           [+ NEW APP]     |
+----------------------------------------------------------------+
| NAME          STATUS    CONTAINERS   CREATED        ACTIONS    |
|----------------------------------------------------------------|
| Jellyfin      ● RUN     3/3          2026-01-15     ▶ ■ ↻ ✕   |
| Syncthing     ● RUN     1/1          2026-01-20     ▶ ■ ↻ ✕   |
| Pi-hole       ● STOP    0/2          2026-02-01     ▶ ■ ↻ ✕   |
+----------------------------------------------------------------+
```

- Tabular layout with monospaced alignment
- Action buttons are small, icon-only, in a row: Start, Stop, Restart, Delete
- Status uses the same dot + label pattern
- Clicking a row name navigates to the App Detail page
- "+ NEW APP" button in accent color, top right

### App Detail Page

Single-app management view with three sections in a vertical stack:

**Section 1: App Header**
- App icon (large, 64x64), name, description, status, external URL link button
- Action bar: Start / Stop / Restart / Pull / Delete buttons

**Section 2: Containers**
- Table of containers in the compose stack
- Columns: Name, Image, Status, CPU %, Memory, Ports
- Per-container resource bars (same style as dashboard metric bars)

**Section 3: Compose Editor**
- Full-width CodeMirror editor showing the docker-compose.yml
- Dark theme matching the DeckOS palette
- Save button triggers validation + rewrite
- Syntax errors shown inline

**Section 4: Logs**
- Tabbed log viewer (one tab per container in the stack)
- Terminal-style rendering: monospace, `--bg-primary` background, `--text-secondary` text
- Auto-scroll with a "follow" toggle
- Timestamp column in `--text-muted`

### App Editor / New App Page

For creating a new app:

```
+--[NEW APP]-------------------------------------------------+
|                                                            |
|  APP NAME:     [________________________]                  |
|  DESCRIPTION:  [________________________]                  |
|  ICON URL:     [________________________]                  |
|  WEB URL:      [________________________]                  |
|                                                            |
|  COMPOSE FILE:                                             |
|  ┌──────────────────────────────────────────────────────┐  |
|  │  version: '3.8'                                      │  |
|  │  services:                                           │  |
|  │    jellyfin:                                         │  |
|  │      image: jellyfin/jellyfin:latest                 │  |
|  │      ports:                                          │  |
|  │        - "8096:8096"                                 │  |
|  │      volumes:                                        │  |
|  │        - ./config:/config                            │  |
|  └──────────────────────────────────────────────────────┘  |
|                                                            |
|  [VALIDATE]                              [CREATE & DEPLOY] |
+------------------------------------------------------------+
```

- Clean form layout, inputs are full-width with 1px borders
- Input focus: border transitions to `--accent-primary`
- The compose editor takes up the majority of vertical space
- Validation errors appear as a red-bordered banner below the editor
- "Create & Deploy" is the primary action in `--accent-primary`

### Settings Page

Minimal for now:
- System information (read-only display of hostname, Docker version, OS, etc.)
- Data directory path display
- About section with version number

## Interaction Patterns

### Buttons

- **Primary**: `background: --accent-primary`, `color: --text-inverse`, no border-radius, `padding: 8px 16px`, uppercase text, `--text-sm`, `letter-spacing: 0.06em`. Hover: `--accent-hover`.
- **Secondary**: `background: transparent`, `border: 1px solid --border-active`, `color: --text-primary`. Hover: `background: --bg-tertiary`.
- **Danger**: `background: transparent`, `border: 1px solid --status-stopped`, `color: --status-stopped`. Hover: filled red.
- **Icon buttons**: 32x32, centered icon, same border treatment as secondary.

### Inputs

- `background: --bg-input`, `border: 1px solid --border-primary`, `color: --text-primary`
- No border-radius
- `padding: 8px 12px`, `font-family: --font-mono`, `--text-base`
- Focus: `border-color: --accent-primary`, `outline: none`
- Labels above inputs, `--text-xs`, uppercase, `--text-secondary`, `margin-bottom: 4px`

### Status Indicators

- 8px square (not circle -- brutalist) filled with the appropriate status color
- Accompanied by uppercase text label
- Optionally pulse animation for "running" status: subtle opacity oscillation (0.6 to 1.0, 2s period)

### Transitions

- All transitions: `80ms linear` or `120ms linear`. Never ease. Never bounce.
- Hover state changes are near-instant (80ms)
- Page transitions: none (instant swap, no animation between routes)
- Loading states: a horizontal scanning line animation (1px tall, accent color, sweeps left to right across the panel)

### Loading & Empty States

- Loading: The scanning line animation within the panel that's loading. No spinners.
- Empty state: centered text in `--text-muted`, uppercase, e.g., `NO APPS INSTALLED` with a muted call-to-action link below.
- Error state: Red-bordered panel with error message in `--status-stopped` color.

## Iconography

- Use a minimal icon set. Prefer [Lucide](https://lucide.dev/) icons at 16px or 20px.
- Icons are always `currentColor` (inherit text color)
- Icon-only buttons have a visible border; icon+text buttons do not need one
- App icons from user-provided URLs, rendered in 48x48 tiles with object-fit contain. Fallback: a square with the first letter of the app name, `--bg-tertiary` background, `--text-secondary` text, `--text-lg`.

## Responsive Behavior

- **1440px+**: Full 4-column metric grid, multi-column app grid
- **1024-1439px**: 4-column metrics, fewer app columns
- **768-1023px**: 2-column metrics, 2-column apps
- **< 768px**: Single column stack, metrics become compact horizontal bars
- Navigation collapses to a hamburger menu below 768px

## Motion & Polish

- Metric bars animate on value change: `width` transition, 500ms linear (smooth gauge movement)
- Sparklines draw incrementally (new points appear, old ones shift left)
- The green accent color subtly glows on primary actions: `box-shadow: 0 0 8px rgba(0, 255, 136, 0.3)` on hover
- The top bar "DECKOS" logotype has a subtle CRT scanline effect on page load (CSS only, removes after 1s)
- Log viewer text appears character-by-character for the initial load (optional, can be disabled)
- Container status changes trigger a brief flash on the status indicator (200ms)

## Fonts Loading Strategy

- Load JetBrains Mono and Space Mono from Google Fonts
- Use `font-display: swap` to prevent FOIT
- Subset to Latin characters for faster load
- Fallback chain ensures the UI never renders in a proportional font
