import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SquadDelegationControls } from "../../components/SquadDelegationControls";
import { createHttpAssignmentClient } from "../../lib/assignment-client";
function App({ config }: { config: { forum: string; owner: string; agents: string[] } }) {
  const [token, setToken] = useState(""), [client, setClient] = useState<ReturnType<typeof createHttpAssignmentClient>>();
  return <main style={{ maxWidth: 900, padding: 30, fontFamily: "sans-serif" }}>
    <h1>Isolated test Squad</h1><p>Synthetic identities. This local service is separate from the public demo and production mesh.</p>
    {!client && <form onSubmit={e => { e.preventDefault(); setClient(createHttpAssignmentClient({ base: "/api/assignment", headers: () => ({ Authorization: `Bearer ${token}` }) })); }}>
      <label>Test owner token <input type="password" data-testid="test-token" value={token} onChange={e => setToken(e.target.value)} /></label><button>Connect</button>
    </form>}
    <h2>Synthetic agents</h2><ol>{config.agents.map((key, i) => <li key={key}>Agent {i + 1}: <code data-testid={`agent-${i + 1}`}>{key}</code></li>)}</ol>
    <SquadDelegationControls scope={{ forum: config.forum, owner: config.owner }} client={client} />
  </main>;
}
fetch("/config").then(r => r.json()).then(config => createRoot(document.getElementById("root")!).render(<App config={config} />));
