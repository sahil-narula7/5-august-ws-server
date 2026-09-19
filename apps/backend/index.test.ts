import { afterAll, beforeAll, expect, test } from "bun:test";

const port = 3400 + Math.floor(Math.random() * 300);
const base = `http://localhost:${port}`;
const cookieFile = `/tmp/trello-test-${port}.sqlite`;
let serverProcess: Bun.Subprocess;
let cookie = "";
let organizationId = "";
let boardId = "";
let sectionId = "";

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${base}${path}`, { ...init, headers });
}

beforeAll(async () => {
  serverProcess = Bun.spawn(["bun", "index.ts"], {
    cwd: import.meta.dir,
    env: { ...Bun.env, PORT: String(port), DATABASE_PATH: cookieFile, RESEND_API_KEY: "", EMAIL_FROM: "" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`${base}/me`);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error("API did not start");
});

afterAll(() => {
  serverProcess.kill();
});

test("requires authentication", async () => {
  const response = await fetch(`${base}/boards`);
  expect(response.status).toBe(401);
});

test("creates an owned organization, board, section, and issue", async () => {
  const signup = await api("/signup", { method: "POST", body: JSON.stringify({ email: `owner-${port}@example.com`, password: "password123" }) });
  expect(signup.status).toBe(200);
  cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");

  const organization = await api("/organization", { method: "POST", body: JSON.stringify({ name: "Owned workspace" }) });
  expect(organization.status).toBe(201);
  organizationId = (await organization.json()).id;

  const board = await api("/board", { method: "POST", body: JSON.stringify({ organizationId, title: "Main board" }) });
  expect(board.status).toBe(201);
  boardId = (await board.json()).id;

  const section = await api("/section", { method: "POST", body: JSON.stringify({ boardId, title: "Todo" }) });
  expect(section.status).toBe(201);
  sectionId = (await section.json()).id;

  const issue = await api("/issue", { method: "POST", body: JSON.stringify({ boardId, sectionId, title: "First issue" }) });
  expect(issue.status).toBe(201);
  expect((await issue.json()).board_id).toBe(boardId);
});

test("notifies organization admins when a new account signs up", async () => {
  const secondUser = await api("/signup", { method: "POST", body: JSON.stringify({ email: `new-admin-${port}@example.com`, password: "password123" }) });
  expect(secondUser.status).toBe(200);

  const adminCookie = cookie;
  const adminHeaders = new Headers({ "content-type": "application/json", cookie: adminCookie });
  const notifications = await fetch(`${base}/notifications`, { headers: adminHeaders });
  expect(notifications.status).toBe(200);
  const payload = await notifications.json() as Array<{ type: string; email: string }>;
  expect(payload.some(item => item.type === "new_account" && item.email === `new-admin-${port}@example.com`)).toBe(true);
});

test("lists only the authenticated user's boards", async () => {
  const response = await api("/boards");
  expect(response.status).toBe(200);
  expect((await response.json()).some((board: { id: string }) => board.id === boardId)).toBe(true);
});

test("accepts an invitation before board access is granted", async () => {
  const adminCookie = cookie;
  const invitedEmail = `member-${port}@example.com`;
  const invitationResponse = await api("/invite", {
    method: "POST",
    body: JSON.stringify({ organizationId, email: invitedEmail }),
  });
  expect(invitationResponse.status).toBe(201);
  const invitation = await invitationResponse.json() as { token: string; emailSent: boolean };
  expect(invitation.emailSent).toBe(false);

  const signup = await api("/signup", {
    method: "POST",
    body: JSON.stringify({ email: invitedEmail, password: "password123" }),
  });
  expect(signup.status).toBe(200);
  const memberCookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";

  const accept = await fetch(`${base}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: memberCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  expect(accept.status).toBe(200);

  const repeatAccept = await fetch(`${base}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: memberCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  expect(repeatAccept.status).toBe(200);

  const memberOrganizations = await fetch(`${base}/organizations`, { headers: { cookie: memberCookie } });
  expect(memberOrganizations.status).toBe(200);
  expect((await memberOrganizations.json()).some((organization: { id: string }) => organization.id === organizationId)).toBe(true);

  const beforeGrant = await fetch(`${base}/boards`, { headers: { cookie: memberCookie } });
  expect((await beforeGrant.json()).some((board: { id: string }) => board.id === boardId)).toBe(false);

  cookie = adminCookie;
  const grant = await api("/board-access", {
    method: "POST",
    body: JSON.stringify({ boardId, email: invitedEmail }),
  });
  expect(grant.status).toBe(200);

  const afterGrant = await fetch(`${base}/boards`, { headers: { cookie: memberCookie } });
  expect((await afterGrant.json()).some((board: { id: string }) => board.id === boardId)).toBe(true);
  cookie = adminCookie;
});

test("lets an admin grant board access to an existing account", async () => {
  const adminCookie = cookie;
  const accountEmail = `account-${port}@example.com`;
  const signup = await api("/signup", {
    method: "POST",
    body: JSON.stringify({ email: accountEmail, password: "password123" }),
  });
  expect(signup.status).toBe(200);
  const accountCookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";

  cookie = adminCookie;
  const grant = await api("/board-access", {
    method: "POST",
    body: JSON.stringify({ boardId, email: accountEmail }),
  });
  expect(grant.status).toBe(200);

  const organizations = await fetch(`${base}/organizations`, { headers: { cookie: accountCookie } });
  expect((await organizations.json()).some((organization: { id: string }) => organization.id === organizationId)).toBe(true);
  const boards = await fetch(`${base}/boards`, { headers: { cookie: accountCookie } });
  expect((await boards.json()).some((board: { id: string }) => board.id === boardId)).toBe(true);

  const memberBoard = await fetch(`${base}/board`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: accountCookie },
    body: JSON.stringify({ organizationId, title: "Member board" }),
  });
  expect(memberBoard.status).toBe(403);

  const promote = await api("/membership", {
    method: "PUT",
    body: JSON.stringify({ organizationId, userId: (await signup.clone().json()).user.id, role: "admin" }),
  });
  expect(promote.status).toBe(200);
  const promotedBoard = await fetch(`${base}/board`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: accountCookie },
    body: JSON.stringify({ organizationId, title: "Admin board" }),
  });
  expect(promotedBoard.status).toBe(201);
  cookie = adminCookie;
});