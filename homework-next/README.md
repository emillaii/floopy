# Homework Assistant (Next.js)

This Next.js app provides an SEO-friendly homework helper UI for students. It reuses the existing AI Champion middleware endpoints (`/api/homework/session` and `/api/homework/session/:id/message`) and keeps the familiar chat experience with support for primary and secondary personas.

## Getting Started

1. **Install dependencies** (requires Node.js 18+):

   ```bash
   cd homework-next
   npm install
   ```

2. **Configure the API base** by creating `.env.local`:

   ```bash
   NEXT_PUBLIC_CHAMPION_API_BASE=http://localhost:4001
   ```

   Adjust the URL if the middleware runs elsewhere.

3. **Run the dev server**:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000 to interact with the homework assistant.

4. **Build for production**:

   ```bash
   npm run build
   npm start
   ```

## Project Structure

- `app/page.jsx` – Home page rendering the homework helper UI.
- `components/HomeworkApp.jsx` – Chat experience built as a client component.
- `lib/api.js` – Thin wrapper around the middleware homework endpoints.
- `app/globals.css` and `components/homework.module.css` – Styling.

## Notes

- SEO metadata (title and description) live in `app/layout.jsx`.
- The app assumes the middleware is already persisting chat history to VikingDB.
- Reuse existing React components by dropping them into the Next.js `components/` directory; the build uses CSS modules for encapsulated styling.
- Account creation uses the middleware `/api/auth/register` endpoint (passwords require ≥6 characters). A successful login or registration response is cached in `localStorage` to keep the user signed in on refresh.
- Signed-in students can name their sessions, resume from previous conversations, and copy the session ID directly from the sidebar. Sessions are sourced from the middleware via `/api/sessions` with full support for PostgreSQL persistence.
