# Collaborative Workspace

A Trello-style collaborative workspace built with React, Bun, SQLite, and Turborepo. Users can create organizations and boards, manage sections and issues, comment in real time through polling, assign work, invite members, and grant board-specific access.

**Live demo:** [Open the app](https://your-app-name.netlify.app)

## Features

- Session-based signup, login, and logout
- Organizations with admin and member roles
- Boards, sections, issue creation, deletion, and drag-and-drop movement
- Issue assignment and discussion comments
- Automatic dashboard refresh every 2 seconds
- Invitation links that survive a closed tab and can be accepted safely more than once
- Admin notifications for new accounts
- Board-specific access grants and removals
- Local SQLite persistence
- Responsive desktop, tablet, and mobile UI

## Project structure

```text
apps/backend/   Bun API server and SQLite schema
apps/frontend/  React application and local frontend proxy
packages/       Shared Turborepo TypeScript and ESLint configuration
```

## Requirements

- Bun 1.3+
- Node.js 18+ for tooling compatibility
- A browser

## Local setup

```bash
git clone https://github.com/sahil-narula7/Worknest-collaborative-workspace.git
cd Worknest-collaborative-workspace
bun install
cp .env.example apps/backend/.env
bun run dev
```

Open `http://localhost:3000`. The frontend runs on port `3000` and proxies `/api` requests to the backend on port `3001`. The backend creates `apps/backend/app.sqlite` automatically. SQLite files are ignored by Git.

Create the first account from the login page. The first organization created by that account gives the account the `admin` role.

### Email invitations

Invitations work locally without email credentials: the app returns a shareable invitation link. For real email delivery, set these values in `apps/backend/.env`:

```env
APP_URL=http://localhost:3000
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=Workspace <invites@your-verified-domain.com>
```

The sender domain must be verified in Resend.

## Commands

```bash
bun run dev
bun run build
bun run check-types
bun test apps/backend/index.test.ts
```

## Deploying the frontend to Netlify

This repository includes [netlify.toml](netlify.toml). In Netlify choose **Add new project > Import an existing project > GitHub**, then select:

`sahil-narula7/Worknest-collaborative-workspace`

Netlify will read the configuration automatically. The important settings are:

- Base directory: `apps/frontend`
- Build command: `bun run build`
- Publish directory: `dist` (relative to the base directory)

Add this environment variable in Netlify:

```env
BUN_PUBLIC_API_URL=https://your-deployed-backend.example.com
```

Deploy the backend first to a Bun-capable host such as Railway, Render, Fly.io, or a VPS. For a Railway deployment, use `apps/backend` as the service root, `bun install` as the install command, and `bun index.ts` as the start command. Attach a persistent volume for SQLite and set `DATABASE_PATH` to its mounted path, such as `/data/app.sqlite`.

Set these backend production variables:

```env
PORT=3001
FRONTEND_ORIGIN=https://your-site.netlify.app
APP_URL=https://your-site.netlify.app
DATABASE_PATH=/data/app.sqlite
COOKIE_SAMESITE=None
COOKIE_SECURE=true
```

Then set Netlify's `BUN_PUBLIC_API_URL` to the public backend URL and deploy the frontend. The Netlify site will be public at the generated `https://your-site.netlify.app` address. Replace the placeholder live-demo URL at the top of this README with that address after deployment.

## GitHub

Repository: https://github.com/sahil-narula7/Worknest-collaborative-workspace
