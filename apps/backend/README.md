# Project API

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev

The API uses SQLite and creates `app.sqlite` in this directory by default. Copy the repository `.env.example` to `.env` when changing ports or database locations.

To make the project yours, start the frontend and choose **Create account** on the sign-in screen. Sign up with your email and password, then create your organization. That account receives the initial `admin` membership.

The backend exposes the API on `http://localhost:3001`; the frontend defaults to that URL and can be changed with `BUN_PUBLIC_API_URL`.

To send real invitation emails, set `APP_URL`, `RESEND_API_KEY`, and `EMAIL_FROM` in `.env`. Create a Resend account, verify a sending domain, and use an address from that domain for `EMAIL_FROM`. The invite link is then sent automatically from the **Invite member** form.
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
