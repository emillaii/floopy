# Floopy

Floopy bundles the AI Champion middleware and a Next.js client that surfaces the homework assistant experience. The root repository gives you a single place to manage both services while keeping their source isolated in `middleware/` and `homework-next/`.

## Repository Layout
- `middleware/` – Express server and supporting scripts that expose the AI Champion API, Postgres stores, Pinecone integration, and knowledge ingestion utilities.
- `homework-next/` – Next.js front end that consumes the middleware to deliver the student homework helper UI.

## Prerequisites
- Node.js 18 or newer (both projects target the same runtime).
- PostgreSQL 14+ for persistent user, session, floppy, and sandbox storage.
- Optional: Pinecone, Ollama, or other vector backends if you plan to enable retrieval-assisted responses (see environment variables below).

## Getting Started
1. **Install dependencies**
   ```bash
   cd middleware
   npm install

   cd ../homework-next
   npm install
   ```

2. **Configure environment variables**
   - Middleware (`middleware/.env` or repository root `.env`):
     - `POSTGRES_CONNECTION_STRING` – required for the Postgres stores.
     - `POSTGRES_SSL` – set to `true` when connecting to managed databases that require TLS.
     - `PINECONE_API_KEY`, `PINECONE_INDEX`, `PINECONE_REGION`, etc. – enable Pinecone-powered retrieval.
     - `OLLAMA_BASE_URL`, `OLLAMA_EMBED_MODEL` – configure local embedding generation.
     - `CHAMPION_LOG_DIR`, `CHAMPION_LOG_STDOUT` – optional logging controls.
   - Front end (`homework-next/.env.local`):
     - `NEXT_PUBLIC_CHAMPION_API_BASE=http://localhost:4001` (or the URL where the middleware runs).

3. **Run the services**
   ```bash
   # Terminal 1: start the middleware API (defaults to port 4001)
   cd middleware
   npm run chat:server

   # Terminal 2: launch the Next.js app (defaults to port 3000)
   cd homework-next
   npm run dev
   ```
   Open http://localhost:3000 to interact with the homework assistant UI backed by the middleware.

## Useful Scripts
- `npm run create:collection` (middleware) – bootstraps the Pinecone collection defined in your environment.
- `npm run ingest:vivaone` (middleware) – ingests VivaOne metadata into the knowledge base.
- `npm run chat:champion` (middleware) – CLI chatbot for quick manual testing.
- `npm run test:retrieval` (middleware) – lightweight retrieval smoke test.
- `npm run build` / `npm run start` (homework-next) – build and run the production Next.js bundle.

## Notes
- The middleware automatically seeds default users and characters when connected to an empty database.
- Logs are written to `logs/` by default; set `CHAMPION_LOG_STDOUT=true` to mirror to the console.
- The Next.js app expects the middleware session endpoints (`/api/homework/session` and related routes) to be reachable under `NEXT_PUBLIC_CHAMPION_API_BASE`.

