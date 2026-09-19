import "./index.css";
import { useRef, useState } from "react";

type Section = "todo" | "in_progress" | "done";

type Issue = {
  id: string;
  title: string;
  section: Section;
};

const initialIssues: Issue[] = [
  { id: "1", title: "Fix background color", section: "todo" },
  { id: "2", title: "Ship the dashboard", section: "done" },
];

export function App() {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const todoInputRef = useRef<HTMLInputElement | null>(null);
  const inProgressInputRef = useRef<HTMLInputElement | null>(null);
  const doneInputRef = useRef<HTMLInputElement | null>(null);

  function addIssue(section: Section, inputRef: React.RefObject<HTMLInputElement | null>) {
    const value = inputRef.current?.value.trim();
    if (!value) return;

    setIssues(current => [
      ...current,
      { id: crypto.randomUUID(), title: value, section },
    ]);
    inputRef.current!.value = "";
  }

  return (
    <div style={{ display: "flex" }}>
      <div style={{ flex: 1 }}>
        <h3>Todo</h3>
        <input ref={todoInputRef} type="text" placeholder="issue title" />
        <button type="button" onClick={() => addIssue("todo", todoInputRef)}>Add issue</button>
        {issues.filter(issue => issue.section === "todo").map(issue => (
          <Card key={issue.id} title={issue.title} />
        ))}
      </div>

      <div style={{ flex: 1 }}>
        <h3>In progress</h3>
        <input ref={inProgressInputRef} type="text" placeholder="issue title" />
        <button type="button" onClick={() => addIssue("in_progress", inProgressInputRef)}>Add issue</button>
        {issues.filter(issue => issue.section === "in_progress").map(issue => (
          <Card key={issue.id} title={issue.title} />
        ))}
      </div>

      <div style={{ flex: 1 }}>
        <h3>Done</h3>
        <input ref={doneInputRef} type="text" placeholder="issue title" />
        <button type="button" onClick={() => addIssue("done", doneInputRef)}>Add issue</button>
        {issues.filter(issue => issue.section === "done").map(issue => (
          <Card key={issue.id} title={issue.title} />
        ))}
      </div>
    </div>
  );
}

function Card({ title }: { title: string }) {
  return (
    <div style={{ border: "1px solid black", padding: 20, margin: 20 }}>
      {title}
    </div>
  );
}

export default App;
