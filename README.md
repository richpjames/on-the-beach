# On The Beach

A lightweight, client-side music tracker for collecting links and keeping tabs on listening status. The app runs entirely in the browser, stores data locally, and works offline once loaded.

## Features
- Add music links with optional title, artist, and item type
- Track listening status (To Listen, Listening, Listened, Revisit, Done)
- Filter the list by status
- Open links directly from the list
- Auto-save to IndexedDB with a SQLite (sql.js) database

## Tech Stack
- Vite + TypeScript
- sql.js (SQLite in the browser via WebAssembly)
- IndexedDB for local persistence

## Getting Started

```bash
npm install
npm run dev
```

Open the URL printed by Vite (typically http://localhost:5173).

## Scripts

```bash
npm run dev       # Start the Vite dev server
npm run build     # Type-check and build for production
npm run preview   # Preview the production build
npm run typecheck # Type-check without building
```

## Data Storage
Data is stored locally in your browser using IndexedDB. Clearing site data will remove your library.

## Notes
- The sql.js WebAssembly file is served from `public/sql-wasm.wasm`.
- The app auto-saves changes and forces a save on page unload.
