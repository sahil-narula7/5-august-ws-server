import { randomUUID } from "node:crypto";
import { db } from "./db";

const port = Number(process.env.PORT ?? 3001);
const sessionDays = 30;
const jsonHeaders = { "content-type": "application/json", "access-control-allow-credentials": "true", "access-control-allow-origin": process.env.FRONTEND_ORIGIN ?? "http://localhost:3000" };
type User = { id: string; email: string };
type Membership = { id: string; user_id: string; organization_id: string; role: "admin" | "member" };

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...jsonHeaders, ...headers } });
}
function error(message: string, status = 400) { return json({ error: message }, status); }
async function body(request: Request) {
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}
function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
function cookieValue(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
function currentUser(request: Request): User | null {
  const token = cookieValue(request, "session");
  if (!token) return null;
  return db.query("SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > datetime('now')").get(token) as User | null;
}
function membership(userId: string, organizationId: string) {
  return db.query("SELECT * FROM memberships WHERE user_id = ? AND organization_id = ?").get(userId, organizationId) as Membership | null;
}
function boardAccess(userId: string, boardId: string) {
  return db.query("SELECT boards.*, memberships.role FROM boards JOIN memberships ON memberships.organization_id = boards.organization_id WHERE boards.id = ? AND memberships.user_id = ? AND (memberships.role = 'admin' OR EXISTS (SELECT 1 FROM board_memberships WHERE board_id = boards.id AND user_id = ?))").get(boardId, userId, userId) as (Record<string, unknown> & { role: "admin" | "member" }) | null;
}
function adminAccess(userId: string, organizationId: string) {
  return db.query("SELECT * FROM memberships WHERE user_id = ? AND organization_id = ? AND role = 'admin'").get(userId, organizationId) as Membership | null;
}
function sessionCookie(token: string, expires: Date) {
  const sameSite = process.env.COOKIE_SAMESITE?.trim() || (process.env.NODE_ENV === "production" ? "None" : "Lax");
  const secure = process.env.COOKIE_SECURE === "true" || (process.env.NODE_ENV === "production" && sameSite === "None");
  return `session=${token}; HttpOnly; SameSite=${sameSite};${secure ? " Secure;" : ""} Path=/; Expires=${expires.toUTCString()}`;
}
function invitationUrl(token: string) {
  return `${process.env.APP_URL ?? "http://localhost:3000"}/?invite=${encodeURIComponent(token)}`;
}
async function sendInvitationEmail(email: string, organizationName: string, url: string) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return false;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `You were invited to join ${organizationName}`,
        html: `<p>You have been invited to join <strong>${organizationName}</strong>.</p><p><a href="${url}">Accept invitation and join the workspace</a></p><p>This invitation expires in 7 days.</p>`,
      }),
    });
  } catch {
    throw new Error("Unable to reach Resend. Check your internet connection and Resend configuration.");
  }
  if (!response.ok) {
    const details = await response.text();
    let message = `Email provider rejected the invitation (${response.status})`;
    try {
      const parsed = JSON.parse(details) as { message?: string };
      if (parsed.message) message += `: ${parsed.message}`;
    } catch { /* Keep the stable provider error when the response is not JSON. */ }
    throw new Error(message);
  }
  return true;
}
function notifyAdminsForNewAccount(email: string) {
  const admins = db.query("SELECT DISTINCT users.id FROM memberships JOIN users ON users.id = memberships.user_id WHERE memberships.role = 'admin' ORDER BY users.email").all() as { id: string }[];
  for (const admin of admins) {
    db.query("INSERT INTO notifications (id, user_id, type, email, message) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), admin.id, "new_account", email, `New account created: ${email}`);
  }
}
async function signup(request: Request) {
  const data = await body(request);
  if (!data) return error("Invalid JSON");
  try {
    const email = text(data.email, "email").toLowerCase();
    const password = text(data.password, "password");
    if (password.length < 8) return error("password must be at least 8 characters");
    const userId = randomUUID();
    db.query("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(userId, email, await Bun.password.hash(password));
    notifyAdminsForNewAccount(email);
    return signinUser({ id: userId, email });
  } catch (cause) {
    if (String(cause).includes("UNIQUE")) return error("email is already registered", 409);
    return error(cause instanceof Error ? cause.message : "Unable to create user");
  }
}
async function signin(request: Request) {
  const data = await body(request);
  if (!data) return error("Invalid JSON");
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const password = typeof data.password === "string" ? data.password : "";
  const record = db.query("SELECT * FROM users WHERE email = ?").get(email) as { id: string; email: string; password_hash: string } | null;
  if (!record || !(await Bun.password.verify(password, record.password_hash))) return error("Invalid credentials", 401);
  return signinUser({ id: record.id, email: record.email });
}
function signinUser(user: User) {
  const token = randomUUID();
  const expires = new Date(Date.now() + sessionDays * 86400000);
  db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, user.id, expires.toISOString());
  return json({ user }, 200, { "set-cookie": sessionCookie(token, expires) });
}
async function createOrganization(request: Request, user: User) {
  const data = await body(request);
  if (!data) return error("Invalid JSON");
  try {
    const name = text(data.name, "name");
    const organizationId = randomUUID();
    db.transaction(() => {
      db.query("INSERT INTO organizations (id, name, description) VALUES (?, ?, ?)").run(organizationId, name, typeof data.description === "string" ? data.description.trim() : null);
      db.query("INSERT INTO memberships (id, user_id, organization_id, role) VALUES (?, ?, ?, 'admin')").run(randomUUID(), user.id, organizationId);
    })();
    return json(db.query("SELECT * FROM organizations WHERE id = ?").get(organizationId), 201);
  } catch (cause) { return error(cause instanceof Error ? cause.message : "Unable to create organization"); }
}
async function createBoard(request: Request, user: User) {
  const data = await body(request);
  if (!data) return error("Invalid JSON");
  try {
    const organizationId = text(data.organizationId, "organizationId");
    if (!membership(user.id, organizationId)) return error("Organization membership required", 403);
    const boardId = randomUUID();
    db.query("INSERT INTO boards (id, title, organization_id) VALUES (?, ?, ?)").run(boardId, text(data.title, "title"), organizationId);
    return json(db.query("SELECT * FROM boards WHERE id = ?").get(boardId), 201);
  } catch (cause) { return error(cause instanceof Error ? cause.message : "Unable to create board"); }
}
async function createSection(request: Request, user: User) {
  const data = await body(request);
  if (!data) return error("Invalid JSON");
  try {
    const boardId = text(data.boardId, "boardId");
    if (!boardAccess(user.id, boardId)) return error("Board access denied", 403);
    const sectionId = randomUUID();
    db.query("INSERT INTO sections (id, title, board_id, position) VALUES (?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM sections WHERE board_id = ?), 0))").run(sectionId, text(data.title, "title"), boardId, boardId);
    return json(db.query("SELECT * FROM sections WHERE id = ?").get(sectionId), 201);
  } catch (cause) { return error(cause instanceof Error ? cause.message : "Unable to create section"); }
}
async function createIssue(request: Request, user: User) {
  const data = await body(request);
  if (!data) return error("Invalid JSON");
  try {
    const boardId = text(data.boardId, "boardId");
    const sectionId = text(data.sectionId, "sectionId");
    if (!boardAccess(user.id, boardId)) return error("Board access denied", 403);
    if (!db.query("SELECT id FROM sections WHERE id = ? AND board_id = ?").get(sectionId, boardId)) return error("Section does not belong to board");
    const issueId = randomUUID();
    db.query("INSERT INTO issues (id, title, description, board_id, section_id) VALUES (?, ?, ?, ?, ?)").run(issueId, text(data.title, "title"), typeof data.description === "string" ? data.description.trim() : "", boardId, sectionId);
    return json(db.query("SELECT * FROM issues WHERE id = ?").get(issueId), 201);
  } catch (cause) { return error(cause instanceof Error ? cause.message : "Unable to create issue"); }
}

const server = Bun.serve({
  port,
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...jsonHeaders, "access-control-allow-origin": request.headers.get("origin") ?? "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
    const url = new URL(request.url);
    const user = currentUser(request);
    try {
      if (request.method === "POST" && url.pathname === "/signup") return signup(request);
      if (request.method === "POST" && url.pathname === "/signin") return signin(request);
      if (request.method === "GET" && url.pathname === "/me") return user ? json({ user }) : error("Authentication required", 401);
      if (request.method === "GET" && url.pathname === "/notifications") return json(db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC").all(user?.id ?? ""));
      if (request.method === "POST" && url.pathname === "/logout") {
        const token = cookieValue(request, "session");
        if (token) db.query("DELETE FROM sessions WHERE token = ?").run(token);
        return json({ loggedOut: true }, 200, { "set-cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
      }
      if (!user) return error("Authentication required", 401);
      if (request.method === "POST" && url.pathname === "/organization") return createOrganization(request, user);
      if (request.method === "GET" && url.pathname === "/organizations") return json(db.query("SELECT organizations.*, memberships.role FROM organizations JOIN memberships ON memberships.organization_id = organizations.id WHERE memberships.user_id = ? ORDER BY organizations.created_at").all(user.id));
      if (request.method === "DELETE" && url.pathname === "/organization") {
        const organizationId = url.searchParams.get("organizationId");
        if (!organizationId || !adminAccess(user.id, organizationId)) return error("Organization admin access required", 403);
        db.query("DELETE FROM organizations WHERE id = ?").run(organizationId);
        return json({ deleted: true });
      }
        if (request.method === "DELETE" && url.pathname === "/membership") {
          const organizationId = url.searchParams.get("organizationId");
          const memberId = url.searchParams.get("userId") ?? user.id;
          if (!organizationId) return error("organizationId is required");
          if (memberId !== user.id && !adminAccess(user.id, organizationId)) return error("Organization admin access required", 403);
          if (memberId === user.id && !adminAccess(user.id, organizationId)) {
            const memberCount = db.query("SELECT COUNT(*) as count FROM memberships WHERE organization_id = ?").get(organizationId) as { count: number };
            if (memberCount.count <= 1) return error("The last organization member cannot leave", 409);
          }
          db.query("DELETE FROM memberships WHERE user_id = ? AND organization_id = ?").run(memberId, organizationId);
          return json({ deleted: true });
        }
        if (request.method === "GET" && url.pathname === "/memberships") {
          const organizationId = url.searchParams.get("organizationId");
          if (!organizationId || !membership(user.id, organizationId)) return error("Organization access denied", 403);
          return json(db.query("SELECT memberships.id, memberships.user_id, users.email, memberships.role FROM memberships JOIN users ON users.id = memberships.user_id WHERE memberships.organization_id = ? ORDER BY users.email").all(organizationId));
        }
      if (request.method === "GET" && url.pathname === "/users") {
        return json(db.query("SELECT id, email FROM users ORDER BY email").all() as { id: string; email: string }[]);
      }
      if (request.method === "GET" && url.pathname === "/board-members") {
        const boardId = url.searchParams.get("boardId");
        if (!boardId) return error("boardId is required", 400);
        const board = db.query("SELECT organization_id FROM boards WHERE id = ?").get(boardId) as { organization_id: string } | null;
        if (!board || !adminAccess(user.id, board.organization_id)) return error("Organization admin access required", 403);
        return json(db.query("SELECT users.id AS user_id, users.email, memberships.role FROM board_memberships JOIN users ON users.id = board_memberships.user_id LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.organization_id = ? WHERE board_memberships.board_id = ? ORDER BY users.email").all(board.organization_id, boardId));
      }
      if (request.method === "GET" && url.pathname === "/boards") return json(db.query("SELECT boards.* FROM boards JOIN memberships ON memberships.organization_id = boards.organization_id WHERE memberships.user_id = ? AND (memberships.role = 'admin' OR EXISTS (SELECT 1 FROM board_memberships WHERE board_id = boards.id AND user_id = ?)) ORDER BY boards.created_at DESC").all(user.id, user.id));
      if (request.method === "POST" && url.pathname === "/board") return createBoard(request, user);
      if (request.method === "PUT" && url.pathname === "/board") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const boardId = text(data.boardId, "boardId");
        const board = db.query("SELECT organization_id FROM boards WHERE id = ?").get(boardId) as { organization_id: string } | null;
        if (!board || !adminAccess(user.id, board.organization_id)) return error("Board access denied", 403);
        db.query("UPDATE boards SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(text(data.title, "title"), boardId);
        return json(db.query("SELECT * FROM boards WHERE id = ?").get(boardId));
      }
      if (request.method === "DELETE" && url.pathname === "/board") {
        const boardId = url.searchParams.get("boardId");
        const board = boardId ? db.query("SELECT organization_id FROM boards WHERE id = ?").get(boardId) as { organization_id: string } | null : null;
        if (!boardId || !board || !adminAccess(user.id, board.organization_id)) return error("Board access denied", 403);
        db.query("DELETE FROM boards WHERE id = ?").run(boardId);
        return json({ deleted: true });
      }
      if ((request.method === "POST" || request.method === "DELETE") && url.pathname === "/board-access") {
        const data = request.method === "POST" ? await body(request) : null;
        const boardId = text(data?.boardId ?? url.searchParams.get("boardId"), "boardId");
        const rawUserId = data?.userId ?? url.searchParams.get("userId");
        const rawEmail = typeof data?.email === "string" ? data.email.trim().toLowerCase() : (url.searchParams.get("email") ?? "").trim().toLowerCase();
        let userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
        if (!userId && rawEmail) {
          const match = db.query("SELECT id FROM users WHERE email = ?").get(rawEmail) as { id: string } | null;
          if (!match) return error("User with that email was not found", 404);
          userId = match.id;
        }
        userId = text(userId, "userId");
        const board = db.query("SELECT organization_id FROM boards WHERE id = ?").get(boardId) as { organization_id: string } | null;
        if (!board || !adminAccess(user.id, board.organization_id)) return error("Organization admin access required", 403);
        if (!db.query("SELECT id FROM users WHERE id = ?").get(userId)) return error("User account was not found", 404);
        if (request.method === "POST") {
          db.query("INSERT OR IGNORE INTO memberships (id, user_id, organization_id, role) VALUES (?, ?, ?, 'member')").run(randomUUID(), userId, board.organization_id);
          db.query("INSERT OR IGNORE INTO board_memberships (id, board_id, user_id) VALUES (?, ?, ?)").run(randomUUID(), boardId, userId);
        } else {
          db.query("DELETE FROM board_memberships WHERE board_id = ? AND user_id = ?").run(boardId, userId);
        }
        return json({ updated: true });
      }
      if (request.method === "POST" && url.pathname === "/section") return createSection(request, user);
      if (request.method === "GET" && url.pathname === "/sections") {
        const boardId = url.searchParams.get("boardId");
        if (!boardId || !boardAccess(user.id, boardId)) return error("Board access denied", 403);
        return json(db.query("SELECT * FROM sections WHERE board_id = ? ORDER BY position, created_at").all(boardId));
      }
      if ((request.method === "PUT" || request.method === "DELETE") && url.pathname === "/section") {
        const data = request.method === "PUT" ? await body(request) : null;
        const sectionId = text(data?.sectionId ?? url.searchParams.get("sectionId"), "sectionId");
        const section = db.query("SELECT sections.*, boards.organization_id FROM sections JOIN boards ON boards.id = sections.board_id WHERE sections.id = ?").get(sectionId) as { organization_id: string } | null;
        if (!section || !adminAccess(user.id, section.organization_id)) return error("Section access denied", 403);
        if (request.method === "PUT") {
          db.query("UPDATE sections SET title = ? WHERE id = ?").run(text(data?.title, "title"), sectionId);
          return json(db.query("SELECT * FROM sections WHERE id = ?").get(sectionId));
        }
        try {
          db.query("DELETE FROM sections WHERE id = ?").run(sectionId);
          return json({ deleted: true });
        } catch { return error("Section cannot be deleted while it contains issues", 409); }
      }
      if (request.method === "POST" && url.pathname === "/issue") return createIssue(request, user);
      if (request.method === "GET" && url.pathname === "/issues") {
        const boardId = url.searchParams.get("boardId");
        if (!boardId || !boardAccess(user.id, boardId)) return error("Board access denied", 403);
        return json(db.query("SELECT * FROM issues WHERE board_id = ? ORDER BY created_at DESC").all(boardId));
      }
      if (request.method === "GET" && url.pathname.startsWith("/issue/")) {
        const issueId = url.pathname.slice("/issue/".length);
        const issue = db.query("SELECT issues.*, boards.organization_id FROM issues JOIN boards ON boards.id = issues.board_id WHERE issues.id = ?").get(issueId) as { board_id: string; organization_id: string } | null;
        if (!issue || !boardAccess(user.id, issue.board_id)) return error("Issue access denied", 403);
        return json({ ...issue, comments: db.query("SELECT comments.*, users.email FROM comments JOIN users ON users.id = comments.user_id WHERE issue_id = ? ORDER BY comments.created_at").all(issueId), assignees: db.query("SELECT users.id, users.email FROM issue_assignees JOIN users ON users.id = issue_assignees.user_id WHERE issue_assignees.issue_id = ?").all(issueId) });
      }
      if (request.method === "PUT" && url.pathname === "/issue") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const issueId = text(data.issueId, "issueId");
        const issue = db.query("SELECT board_id FROM issues WHERE id = ?").get(issueId) as { board_id: string } | null;
        if (!issue || !boardAccess(user.id, issue.board_id)) return error("Issue access denied", 403);
        db.query("UPDATE issues SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(text(data.title, "title"), typeof data.description === "string" ? data.description.trim() : "", issueId);
        return json(db.query("SELECT * FROM issues WHERE id = ?").get(issueId));
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/issue/")) {
        const issueId = url.pathname.slice("/issue/".length);
        const issue = db.query("SELECT board_id FROM issues WHERE id = ?").get(issueId) as { board_id: string } | null;
        if (!issue || !boardAccess(user.id, issue.board_id)) return error("Issue access denied", 403);
        db.query("DELETE FROM issues WHERE id = ?").run(issueId);
        return json({ deleted: true });
      }
      if (request.method === "PUT" && url.pathname === "/issue/move") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const issueId = text(data.issueId, "issueId");
        const sectionId = text(data.sectionId, "sectionId");
        const issue = db.query("SELECT board_id FROM issues WHERE id = ?").get(issueId) as { board_id: string } | null;
        if (!issue || !boardAccess(user.id, issue.board_id)) return error("Issue access denied", 403);
        if (!db.query("SELECT id FROM sections WHERE id = ? AND board_id = ?").get(sectionId, issue.board_id)) return error("Section does not belong to issue board");
        db.query("UPDATE issues SET section_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sectionId, issueId);
        return json(db.query("SELECT * FROM issues WHERE id = ?").get(issueId));
      }
      if (request.method === "POST" && url.pathname === "/assign") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const issueId = text(data.issueId, "issueId");
        const userId = text(data.userId, "userId");
        const issue = db.query("SELECT board_id FROM issues WHERE id = ?").get(issueId) as { board_id: string } | null;
        const target = db.query("SELECT boards.organization_id FROM boards JOIN issues ON issues.board_id = boards.id WHERE issues.id = ? AND boards.organization_id IN (SELECT organization_id FROM memberships WHERE user_id = ?)").get(issueId, userId) as { organization_id: string } | null;
        if (!issue || !boardAccess(user.id, issue.board_id) || !target) return error("Assignment access denied", 403);
        db.query("INSERT OR IGNORE INTO issue_assignees (id, issue_id, user_id) VALUES (?, ?, ?)").run(randomUUID(), issueId, userId);
        return json({ assigned: true });
      }
      if (request.method === "POST" && url.pathname === "/comment") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const issueId = text(data.issueId, "issueId");
        const issue = db.query("SELECT board_id FROM issues WHERE id = ?").get(issueId) as { board_id: string } | null;
        if (!issue || !boardAccess(user.id, issue.board_id)) return error("Issue access denied", 403);
        const commentId = randomUUID();
        db.query("INSERT INTO comments (id, issue_id, user_id, body) VALUES (?, ?, ?, ?)").run(commentId, issueId, user.id, text(data.body, "body"));
        return json(db.query("SELECT comments.*, users.email FROM comments JOIN users ON users.id = comments.user_id WHERE comments.id = ?").get(commentId), 201);
      }
      if (request.method === "DELETE" && url.pathname === "/comment") {
        const commentId = url.searchParams.get("commentId");
        const comment = commentId ? db.query("SELECT comments.*, issues.board_id FROM comments JOIN issues ON issues.id = comments.issue_id WHERE comments.id = ?").get(commentId) as { user_id: string; board_id: string } | null : null;
        if (!comment || !boardAccess(user.id, comment.board_id)) return error("Comment access denied", 403);
        if (comment.user_id !== user.id) return error("Only the comment author can delete it", 403);
        db.query("DELETE FROM comments WHERE id = ?").run(commentId);
        return json({ deleted: true });
      }
      if (request.method === "POST" && url.pathname === "/invite") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const organizationId = text(data.organizationId, "organizationId");
        if (!adminAccess(user.id, organizationId)) return error("Organization admin access required", 403);
        const email = text(data.email, "email").toLowerCase();
        const token = randomUUID();
        const organization = db.query("SELECT name FROM organizations WHERE id = ?").get(organizationId) as { name: string } | null;
        if (!organization) return error("Organization not found", 404);
        const url = invitationUrl(token);
        let emailSent = false;
        try { emailSent = await sendInvitationEmail(email, organization.name, url); }
        catch (cause) { return error(cause instanceof Error ? cause.message : "Unable to send invitation email", 502); }
        db.query("INSERT INTO invitations (id, token, email, organization_id, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'))").run(randomUUID(), token, email, organizationId, user.id);
        return json({ token, invitationUrl: url, email, organizationId, status: "pending", emailSent }, 201);
      }
      if (request.method === "POST" && url.pathname === "/accept") {
        const data = await body(request);
        if (!data) return error("Invalid JSON");
        const token = text(data.token, "token");
        const invitation = db.query("SELECT * FROM invitations WHERE token = ? AND status IN ('pending', 'accepted') AND (status = 'accepted' OR expires_at > datetime('now'))").get(token) as { id: string; email: string; organization_id: string } | null;
        if (!invitation || invitation.email !== user.email) return error("Invitation is invalid or does not belong to this account", 403);
        db.transaction(() => {
          db.query("INSERT OR IGNORE INTO memberships (id, user_id, organization_id, role) VALUES (?, ?, ?, 'member')").run(randomUUID(), user.id, invitation.organization_id);
          db.query("UPDATE invitations SET status = 'accepted' WHERE id = ?").run(invitation.id);
        })();
        return json({ accepted: true, organizationId: invitation.organization_id });
      }
      return error("Not found", 404);
    } catch (cause) { return error(cause instanceof Error ? cause.message : "Internal server error", 500); }
  },
});

console.log(`API server running at ${server.url}`);