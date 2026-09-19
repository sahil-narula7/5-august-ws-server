import "./index.css";
import { useEffect, useState, type FormEvent } from "react";

const API = process.env.BUN_PUBLIC_API_URL?.trim() || "/api";
const INVITE_STORAGE_KEY = "workspace-invite-token";
const AUTH_STORAGE_KEY = "workspace-session-token";

type User = { id: string; email: string };
type Organization = { id: string; name: string; role: "admin" | "member" };
type Board = { id: string; title: string; organization_id: string };
type Section = { id: string; title: string; board_id: string };
type Member = { user_id: string; email: string; role: "admin" | "member" };
type NotificationItem = { id: string; type: string; email: string; message: string; created_at: string };
type Comment = { id: string; body: string; email: string; user_id: string };
type Issue = { id: string; title: string; description: string; section_id: string; comments?: Comment[]; assignees?: User[] };

function commentTone(userId: string) {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 6;
}

async function request<T>(path: string, options: RequestInit = {}) {
  const token = window.localStorage.getItem(AUTH_STORAGE_KEY);
  const response = await fetch(`${API}${path}`, { ...options, credentials: "include", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("The API URL is not configured correctly. Set BUN_PUBLIC_API_URL to the Railway backend URL and redeploy Netlify.");
  }
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [draggingIssueId, setDraggingIssueId] = useState<string | null>(null);
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [organizationFormOpen, setOrganizationFormOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState(() => {
    const urlToken = new URLSearchParams(window.location.search).get("invite");
    if (urlToken) window.localStorage.setItem(INVITE_STORAGE_KEY, urlToken);
    return urlToken ?? window.localStorage.getItem(INVITE_STORAGE_KEY) ?? "";
  });

  const visibleBoards = boards.filter(board => board.organization_id === organizationId);
  const currentOrganization = organizations.find(organization => organization.id === organizationId);

  async function loadWorkspace() {
    const [organizationData, boardData] = await Promise.all([
      request<Organization[]>("/organizations"),
      request<Board[]>("/boards"),
    ]);
    setOrganizations(organizationData);
    setOrganizationId(current => current || organizationData[0]?.id || "");
    setBoards(boardData);
    setBoardId(current => current || boardData[0]?.id || "");
  }

  async function loadMembers() {
    if (!organizationId) return;
    setMembers(await request<Member[]>(`/memberships?organizationId=${organizationId}`));
  }

  async function loadUsers() {
    setAllUsers(await request<User[]>("/users"));
  }

  async function loadNotifications() {
    setNotifications(await request<NotificationItem[]>("/notifications"));
  }

  async function refreshBoardData() {
    if (!boardId) return;
    const [sectionData, issueData] = await Promise.all([
      request<Section[]>(`/sections?boardId=${boardId}`),
      request<Issue[]>(`/issues?boardId=${boardId}`),
    ]);
    setSections(sectionData);
    setIssues(issueData);
    if (selectedIssue) {
      const updatedIssue = await request<Issue>(`/issue/${selectedIssue.id}`);
      setSelectedIssue(updatedIssue);
    }
  }

  async function refreshDashboard() {
    if (!user) return;
    await Promise.allSettled([
      loadWorkspace(),
      loadUsers(),
      loadNotifications(),
      organizationId ? loadMembers() : Promise.resolve(),
      refreshBoardData(),
    ]);
  }

  useEffect(() => {
    request<{ user: User }>("/me").then(async data => {
      if (inviteToken) await acceptInvitationToken(inviteToken);
      setUser(data.user);
      await Promise.all([loadWorkspace(), loadUsers(), loadNotifications()]);
    }).catch(cause => {
      if (cause instanceof Error && cause.message === "Authentication required") {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      } else {
        showError(cause);
      }
      setAuthReady(true);
    }).finally(() => {
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void refreshDashboard();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [user, organizationId, boardId, selectedIssue?.id]);

  useEffect(() => {
    void loadMembers().catch(showError);
  }, [organizationId]);

  useEffect(() => {
    if (!boardId) return;
    Promise.all([
      request<Section[]>(`/sections?boardId=${boardId}`),
      request<Issue[]>(`/issues?boardId=${boardId}`),
    ]).then(([sectionData, issueData]) => {
      setSections(sectionData);
      setIssues(issueData);
    }).catch(showError);
  }, [boardId]);

  function showError(cause: unknown) {
    setError(cause instanceof Error ? cause.message : "Request failed");
  }

  function clearMessages() {
    setError("");
    setNotice("");
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    const form = new FormData(event.currentTarget);
    try {
      const data = await request<{ user: User; token: string }>(form.get("mode") === "signup" ? "/signup" : "/signin", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      window.localStorage.setItem(AUTH_STORAGE_KEY, data.token);
      if (inviteToken) await acceptInvitationToken(inviteToken);
      setUser(data.user);
      await loadWorkspace();
    } catch (cause) {
      if (cause instanceof Error && cause.message === "email is already registered") {
        setError("This email already has an account. Choose Sign in instead of Create account.");
      } else {
        showError(cause);
      }
    }
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    const form = new FormData(event.currentTarget);
    try {
      const organization = await request<Organization>("/organization", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), description: form.get("description") }),
      });
      await loadWorkspace();
      setOrganizations(current => current.some(item => item.id === organization.id) ? current : [...current, organization]);
      setOrganizationId(organization.id);
      setBoardId("");
      setSections([]);
      setIssues([]);
      setOrganizationFormOpen(false);
    } catch (cause) {
      showError(cause);
    }
  }

  async function createBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const board = await request<Board>("/board", {
        method: "POST",
        body: JSON.stringify({ organizationId, title: form.get("title") }),
      });
      setBoards(current => [...current, board]);
      setBoardId(board.id);
      formElement.reset();
    } catch (cause) {
      showError(cause);
    }
  }

  async function deleteBoard() {
    if (!boardId || !window.confirm("Delete this board and all of its issues?")) return;
    try {
      await request(`/board?boardId=${boardId}`, { method: "DELETE" });
      const remaining = boards.filter(board => board.id !== boardId);
      setBoards(remaining);
      setBoardId(remaining[0]?.id ?? "");
      setNotice("Board deleted");
    } catch (cause) {
      showError(cause);
    }
  }

  async function createSection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const section = await request<Section>("/section", {
        method: "POST",
        body: JSON.stringify({ boardId, title: form.get("title") }),
      });
      setSections(current => [...current, section]);
      formElement.reset();
    } catch (cause) {
      showError(cause);
    }
  }

  async function deleteSection(sectionId: string) {
    if (!window.confirm("Delete this section? It must be empty first.")) return;
    try {
      await request(`/section?sectionId=${sectionId}`, { method: "DELETE" });
      setSections(current => current.filter(section => section.id !== sectionId));
      setNotice("Section deleted");
    } catch (cause) {
      showError(cause);
    }
  }

  async function deleteIssue(issueId: string) {
    if (!window.confirm("Close and remove this issue?")) return;
    try {
      await request(`/issue/${issueId}`, { method: "DELETE" });
      setIssues(current => current.filter(issue => issue.id !== issueId));
      setSelectedIssue(null);
      setNotice("Issue closed");
    } catch (cause) {
      showError(cause);
    }
  }

  async function createIssue(event: FormEvent<HTMLFormElement>, sectionId: string) {
    event.preventDefault();
    clearMessages();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const issue = await request<Issue>("/issue", {
        method: "POST",
        body: JSON.stringify({ boardId, sectionId, title: form.get("title"), description: form.get("description") }),
      });
      setIssues(current => [issue, ...current]);
      formElement.reset();
    } catch (cause) {
      showError(cause);
    }
  }

  async function moveIssue(issueId: string, sectionId: string) {
    try {
      const issue = await request<Issue>("/issue/move", {
        method: "PUT",
        body: JSON.stringify({ issueId, sectionId }),
      });
      setIssues(current => current.map(item => item.id === issue.id ? { ...item, section_id: issue.section_id } : item));
      setNotice("Issue moved");
    } catch (cause) {
      showError(cause);
    }
  }

  async function dropIssue(sectionId: string) {
    if (!draggingIssueId) return;
    const issueId = draggingIssueId;
    setDraggingIssueId(null);
    setDragOverSectionId(null);
    await moveIssue(issueId, sectionId);
  }

  async function openIssue(issue: Issue) {
    try {
      setSelectedIssue(await request<Issue>(`/issue/${issue.id}`));
    } catch (cause) {
      showError(cause);
    }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIssue) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await request("/comment", {
        method: "POST",
        body: JSON.stringify({ issueId: selectedIssue.id, body: form.get("body") }),
      });
      setSelectedIssue(await request<Issue>(`/issue/${selectedIssue.id}`));
      formElement.reset();
    } catch (cause) {
      showError(cause);
    }
  }

  async function assignIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIssue) return;
    const form = new FormData(event.currentTarget);
    try {
      await request("/assign", {
        method: "POST",
        body: JSON.stringify({ issueId: selectedIssue.id, userId: form.get("userId") }),
      });
      setSelectedIssue(await request<Issue>(`/issue/${selectedIssue.id}`));
    } catch (cause) {
      showError(cause);
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const invitation = await request<{ invitationUrl: string; emailSent: boolean }>("/invite", {
        method: "POST",
        body: JSON.stringify({ organizationId, email: form.get("email") }),
      });
      setNotice(invitation.emailSent
        ? `Invitation email sent. Link: ${invitation.invitationUrl}`
        : `Email is not configured. Share this invitation link: ${invitation.invitationUrl}`);
      formElement.reset();
    } catch (cause) {
      showError(cause);
    }
  }

  async function acceptInvitationToken(token: string) {
    const result = await request<{ organizationId: string }>("/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    setInviteToken("");
    window.localStorage.removeItem(INVITE_STORAGE_KEY);
    window.history.replaceState({}, document.title, window.location.pathname);
    setNotice(`You joined organization ${result.organizationId}`);
  }

  async function logout() {
    try {
      await request("/logout", { method: "POST" });
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      setUser(null);
      setOrganizations([]);
      setBoards([]);
      setBoardId("");
      setSettingsOpen(false);
    } catch (cause) {
      showError(cause);
    }
  }

  async function removeMember(memberId: string) {
    if (!window.confirm("Remove this person from the organization?")) return;
    try {
      await request(`/membership?organizationId=${organizationId}&userId=${memberId}`, { method: "DELETE" });
      await loadMembers();
      setNotice("Member removed");
    } catch (cause) {
      showError(cause);
    }
  }

  async function updateMemberRole(memberId: string, role: "admin" | "member") {
    try {
      await request("/membership", {
        method: "PUT",
        body: JSON.stringify({ organizationId, userId: memberId, role }),
      });
      await loadMembers();
      await loadWorkspace();
      setNotice(role === "admin" ? "Member promoted to admin" : "Admin changed to normal member");
    } catch (cause) {
      showError(cause);
    }
  }

  async function deleteOrganization() {
    if (!organizationId || !window.confirm("Delete this organization, its boards, and all issues?")) return;
    try {
      await request(`/organization?organizationId=${organizationId}`, { method: "DELETE" });
      const remaining = organizations.filter(organization => organization.id !== organizationId);
      setOrganizations(remaining);
      setOrganizationId(remaining[0]?.id ?? "");
      setBoards([]);
      setBoardId("");
      setSettingsOpen(false);
      setNotice("Organization deleted");
    } catch (cause) {
      showError(cause);
    }
  }

  async function updateBoardAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request("/board-access", {
        method: "POST",
        body: JSON.stringify({ boardId: form.get("boardId"), userId: form.get("userId"), email: form.get("email") }),
      });
      setNotice("Board access granted");
    } catch (cause) {
      showError(cause);
    }
  }

  async function revokeBoardAccess(boardIdToRevoke: string, userId: string) {
    try {
      await request(`/board-access?boardId=${boardIdToRevoke}&userId=${userId}`, { method: "DELETE" });
      setNotice("Board access removed");
    } catch (cause) {
      showError(cause);
    }
  }

  if (!authReady) {
    return <main className="board-shell"><section className="auth-panel"><p className="eyebrow">Worknest</p><h1>Loading your workspace...</h1></section></main>;
  }

  if (!user) {
    return (
      <main className="board-shell">
        <section className="auth-panel">
          <p className="eyebrow">Project workspace</p>
          <h1>{inviteToken ? "Join your workspace" : "Sign in to your board"}</h1>
          {inviteToken && <p className="notice-message">Create an account or sign in with the invited email to join this organization.</p>}
          <form onSubmit={authenticate}>
            <input name="email" type="email" placeholder="Email" required />
            <input name="password" type="password" placeholder="Password" minLength={8} required />
            <select name="mode">
              <option value="signin">Sign in</option>
              <option value="signup">Create account</option>
            </select>
            <button type="submit">Continue</button>
          </form>
          <Message error={error} />
        </section>
      </main>
    );
  }

  if (organizations.length === 0) {
    return (
      <main className="board-shell">
        <section className="auth-panel">
          <p className="eyebrow">Welcome, {user.email}</p>
          <h1>Create your organization</h1>
          <form onSubmit={createOrganization}>
            <input name="name" placeholder="Organization name" required />
            <textarea name="description" placeholder="Description" />
            <button type="submit">Create organization</button>
          </form>
          <Message error={error} />
        </section>
      </main>
    );
  }

  return (
    <main className="board-shell">
      <header className="board-header">
        <div>
          <p className="eyebrow">{user.email}</p>
          <h1>Workspace</h1>
        </div>
        <div className="board-actions">
          <select value={organizationId} onChange={event => { setOrganizationId(event.target.value); setBoardId(""); setSections([]); setIssues([]); setSettingsOpen(false); }} aria-label="Organization">
            {organizations.map(organization => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
          <select value={boardId} onChange={event => setBoardId(event.target.value)} aria-label="Board">
            <option value="">Choose board</option>
            {visibleBoards.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}
          </select>
          <button className="settings-button" type="button" onClick={() => setSettingsOpen(current => !current)} aria-label="Open organization settings" title="Organization settings">⚙ Settings</button>
          <button className="logout-button" type="button" onClick={() => void logout()}>Log out</button>
        </div>
      </header>

      <Message error={error} notice={notice} />

      {settingsOpen && currentOrganization?.role === "admin" && (
        <SettingsPanel
          members={members}
          users={allUsers}
          notifications={notifications}
          boards={visibleBoards}
          onInvite={inviteMember}
          onRemove={removeMember}
          onRoleChange={updateMemberRole}
          onGrant={updateBoardAccess}
          onRevoke={revokeBoardAccess}
          onDeleteOrganization={() => void deleteOrganization()}
        />
      )}

      <section className="workspace-tools">
        <button className="settings-button" type="button" onClick={() => setOrganizationFormOpen(current => !current)}>+ New organization</button>

        {organizationFormOpen && (
          <form className="new-column-form organization-form" onSubmit={createOrganization}>
            <input name="name" placeholder="Organization name" required />
            <input name="description" placeholder="Description" />
            <button type="submit">Create</button>
          </form>
        )}

        {currentOrganization?.role === "admin" && (
          <form className="new-column-form board-form" onSubmit={createBoard}>
            <input name="title" placeholder="New board title" required />
            <button type="submit">Create board</button>
          </form>
        )}

        {boardId && (
          <form className="new-column-form section-form" onSubmit={createSection}>
            <input name="title" placeholder="New section title" required />
            <button type="submit">Add section</button>
          </form>
        )}

        {boardId && currentOrganization?.role === "admin" && <button className="danger-button" type="button" onClick={() => void deleteBoard()}>Delete board</button>}

        <div className="board-grid">
          {sections.map(section => (
            <div
              className={`column${dragOverSectionId === section.id ? " column--over" : ""}`}
              key={section.id}
              onDragOver={event => { event.preventDefault(); setDragOverSectionId(section.id); }}
              onDragLeave={() => setDragOverSectionId(current => current === section.id ? null : current)}
              onDrop={() => void dropIssue(section.id)}
            >
              <div className="column-header">
                <div>
                  <h2>{section.title}</h2>
                  <span>{issues.filter(issue => issue.section_id === section.id).length}</span>
                </div>
                <button className="delete-section-button" type="button" onClick={() => void deleteSection(section.id)}>Delete</button>
              </div>

              {issues.filter(issue => issue.section_id === section.id).map(issue => (
                <article
                  className="issue-card"
                  draggable
                  key={issue.id}
                  onDragStart={() => setDraggingIssueId(issue.id)}
                  onDragEnd={() => { setDraggingIssueId(null); setDragOverSectionId(null); }}
                  onClick={() => void openIssue(issue)}
                >
                  <div className="issue-card-content">
                    <strong>{issue.title}</strong>
                    <small>{issue.description || "No description"}</small>
                  </div>
                  <select
                    className="issue-move-select"
                    value={issue.section_id}
                    onClick={event => event.stopPropagation()}
                    onChange={event => void moveIssue(issue.id, event.target.value)}
                    aria-label={`Move ${issue.title} to section`}
                  >
                    {sections.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
                  </select>
                </article>
              ))}

              <form className="new-issue-form" onSubmit={event => void createIssue(event, section.id)}>
                <input name="title" placeholder="Issue title" required />
                <textarea name="description" placeholder="Description" />
                <button type="submit">Add issue</button>
              </form>
            </div>
          ))}

        </div>

        {selectedIssue && (
          <IssueDrawer
            issue={selectedIssue}
            members={members}
            onAssign={assignIssue}
            onComment={addComment}
            onDelete={deleteIssue}
            onClose={() => setSelectedIssue(null)}
          />
        )}
      </section>
    </main>
  );
}

function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>
    {error && <p role="alert" className="error-message">{error}</p>}
    {notice && <p className="notice-message">{notice}</p>}
  </>;
}

function SettingsPanel({
  members,
  users,
  notifications,
  boards,
  onInvite,
  onRemove,
  onRoleChange,
  onGrant,
  onRevoke,
  onDeleteOrganization,
}: {
  members: Member[];
  users: User[];
  notifications: NotificationItem[];
  boards: Board[];
  onInvite: (event: FormEvent<HTMLFormElement>) => void;
  onRemove: (memberId: string) => void;
  onRoleChange: (memberId: string, role: "admin" | "member") => void;
  onGrant: (event: FormEvent<HTMLFormElement>) => void;
  onRevoke: (boardId: string, userId: string) => void;
  onDeleteOrganization: () => void;
}) {
  const boardMembers = members.filter(member => member.role !== "admin");

  return (
    <section className="settings-panel">
      <div className="settings-heading">
        <div>
          <p className="eyebrow">Organization admin</p>
          <h2>Settings</h2>
        </div>
        <span>{members.length} member{members.length === 1 ? "" : "s"}</span>
      </div>

      {notifications.length > 0 && (
        <div className="notification-list">
          <p className="eyebrow">Admin alerts</p>
          {notifications.map(notification => (
            <div key={notification.id} className="notice-message">{notification.message}</div>
          ))}
        </div>
      )}

      <form className="invite-form" onSubmit={onInvite}>
        <input name="email" type="email" placeholder="person@example.com" required />
        <button type="submit">Send invite email</button>
      </form>

      <form className="access-form" onSubmit={onGrant}>
        <select name="userId" required>
          <option value="">Choose member email</option>
          {users.map(user => <option key={user.id} value={user.id}>{user.email}</option>)}
        </select>
        <select name="boardId" required>
          <option value="">Choose board</option>
          {boards.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}
        </select>
        <button type="submit">Grant board access</button>
      </form>

      <form className="access-form" onSubmit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const userId = String(form.get("removeBoardUserId") ?? "");
        const boardId = String(form.get("removeBoardId") ?? "");
        if (userId && boardId) onRevoke(boardId, userId);
      }}>
        <select name="removeBoardUserId" required>
          <option value="">Choose member</option>
          {boardMembers.map(member => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
        </select>
        <select name="removeBoardId" required>
          <option value="">Choose board</option>
          {boards.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}
        </select>
        <button type="submit">Remove from this board</button>
      </form>

      <div className="member-list">
        {members.map(member => (
          <div className="member-row" key={member.user_id}>
            <div>
              <strong>{member.email}</strong>
              <select
                className="member-role-select"
                value={member.role}
                disabled={member.role === "admin" && members.filter(item => item.role === "admin").length === 1}
                onChange={event => onRoleChange(member.user_id, event.target.value as "admin" | "member")}
                aria-label={`Role for ${member.email}`}
              >
                <option value="member">Normal member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {member.role !== "admin" && (
              <button className="danger-button" type="button" onClick={() => onRemove(member.user_id)}>Remove from organization</button>
            )}
          </div>
        ))}
      </div>

      <button className="danger-button organization-delete" type="button" onClick={onDeleteOrganization}>Delete organization</button>
    </section>
  );
}

function IssueDrawer({
  issue,
  members,
  onAssign,
  onComment,
  onDelete,
  onClose,
}: {
  issue: Issue;
  members: Member[];
  onAssign: (event: FormEvent<HTMLFormElement>) => void;
  onComment: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: (issueId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="detail-backdrop" onClick={onClose}>
      <aside className="issue-detail" onClick={event => event.stopPropagation()}>
        <button className="close-button" type="button" onClick={onClose} aria-label="Close issue details">×</button>
        <p className="eyebrow">Issue discussion</p>
        <h2>{issue.title}</h2>
        <p className="issue-description">{issue.description || "No description yet."}</p>

        <form className="assignment-form" onSubmit={onAssign}>
          <label htmlFor="assignee">Assign to</label>
          <select id="assignee" name="userId" defaultValue={issue.assignees?.[0]?.id ?? ""}>
            <option value="">Choose a member</option>
            {members.map(member => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
          </select>
          <button type="submit">Assign</button>
        </form>

        <div className="discussion-heading">
          <h3>Discussion</h3>
          <span>{issue.comments?.length ?? 0}</span>
        </div>

        <div className="comments">
          {issue.comments?.length ? (
            issue.comments.map(comment => (
              <div className={`comment comment--tone-${commentTone(comment.user_id)}`} key={comment.id}>
                <strong>{comment.email}</strong>
                <p>{comment.body}</p>
              </div>
            ))
          ) : (
            <p className="empty-comments">No discussion yet. Add the current status or next step.</p>
          )}
        </div>

        <form className="comment-form" onSubmit={onComment}>
          <textarea name="body" placeholder="Is this fixed? What remains?" required />
          <button type="submit">Add comment</button>
        </form>

        <button className="danger-button close-issue-button" type="button" onClick={() => onDelete(issue.id)}>Close issue</button>
      </aside>
    </div>
  );
}

export default App;
