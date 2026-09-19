import { serve } from "bun";
import index from "./index.html";

type Column = { id: string; label: string };
type Comment = { id: number; text: string; author: string };
type Issue = { id: number; title: string; description: string; section: string; comments: Comment[] };
type Client = { send(message: string): void };

let columns: Column[] = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
];
let issues: Issue[] = [
  { id: 1, title: "Fix background color", description: "Make the workspace feel lighter.", section: "todo", comments: [] },
  { id: 2, title: "Fix background color", description: "", section: "done", comments: [] },
];
const clients = new Set<Client>();

function broadcast(message: object) {
  const serializedMessage = JSON.stringify(message);
  clients.forEach(client => client.send(serializedMessage));
}

async function proxyToBackend(request: Request) {
  const url = new URL(request.url);
  const backendUrl = new URL(request.url);
  backendUrl.protocol = "http:";
  backendUrl.hostname = "localhost";
  backendUrl.port = "3001";
  backendUrl.pathname = url.pathname.slice("/api".length);
  try {
    return await fetch(new Request(backendUrl, request));
  } catch {
    return Response.json(
      { error: "The backend is unavailable. Start the backend on port 3001 and try again." },
      { status: 502 },
    );
  }
}

const server = serve({
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return proxyToBackend(req);
    }
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
  },
  routes: {
    "/api/*": proxyToBackend,
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async req => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  websocket: {
    open(client) {
      clients.add(client);
      client.send(JSON.stringify({ type: "initial_state", issues, columns }));
    },
    message(_client, message) {
      const parsedData = JSON.parse(message.toString());

      if (parsedData.type === "issue_added") {
        const issue = {
          id: Math.random(),
          title: parsedData.title,
          description: parsedData.description ?? "",
          section: parsedData.section,
          comments: [],
        };
        issues.push(issue);
        broadcast({ type: "issue_added", issue });
      }

      if (parsedData.type === "delete_issue") {
        issues = issues.filter(issue => issue.id !== parsedData.issueId);
        broadcast({ type: "delete_issue", issueId: parsedData.issueId });
      }

      if (parsedData.type === "move_issue") {
        const issue = issues.find(item => item.id === parsedData.issueId);
        if (issue && columns.some(column => column.id === parsedData.newSection)) {
          issue.section = parsedData.newSection;
          broadcast({ type: "issue_moved", issueId: issue.id, section: issue.section });
        }
      }

      if (parsedData.type === "column_added") {
        const column = { id: `column-${Date.now()}-${Math.random().toString(16).slice(2)}`, label: parsedData.label };
        columns.push(column);
        broadcast({ type: "column_added", column });
      }

      if (parsedData.type === "comment_added") {
        const issue = issues.find(item => item.id === parsedData.issueId);
        if (issue && parsedData.text?.trim()) {
          const comment = { id: Math.random(), text: parsedData.text.trim(), author: "You" };
          issue.comments.push(comment);
          broadcast({ type: "comment_added", issueId: issue.id, comment });
        }
      }
    },
    close(client) {
      clients.delete(client);
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
