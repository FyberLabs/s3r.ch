"use client";

import { useState } from "react";
import {
  admitComposedChat,
  CHAT_BODY_MAX,
  composeChat,
  rankChatMessages,
  type ChatMessage,
} from "@/lib/chat";
import { useBrand } from "@/components/brand";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import { btnPrimary, field, panel } from "@/lib/brand-ui";

export function RoomChat({
  roomId,
  messages,
  onPublicGraph,
  seedWsUp,
  onComposed,
}: {
  roomId: string;
  messages: ChatMessage[];
  onPublicGraph: boolean;
  seedWsUp: boolean;
  onComposed: (message: ChatMessage, putOnGun: boolean) => void;
}) {
  const listed = rankChatMessages(messages);
  const { reader } = useBrand();

  return (
    <div className={`mt-6 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Live chat</h2>
      <p className="mt-2 text-xs text-ink-muted">
        Messages in this room.
        {onPublicGraph
          ? ""
          : " Private until you share the room."}
      </p>
      {listed.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          {onPublicGraph
            ? "No chat in this room yet."
            : "No local chat in this room yet."}
        </p>
      ) : (
        reader === "ai" ? (
          <div className="mt-3 overflow-x-auto">
            <table className="brand-table">
              <thead>
                <tr>
                  <th scope="col">author</th>
                  <th scope="col">body</th>
                  <th scope="col">ts</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((row) => (
                  <tr key={row.id}>
                    <td className="font-data">{shortAuthor(row.author)}</td>
                    <td className="whitespace-normal">{row.body}</td>
                    <td className="font-data">
                      {row.ts
                        ? new Date(row.ts * 1000).toISOString().replace(".000Z", "Z")
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {listed.map((row) => (
              <li key={row.id} className="border border-rule bg-ground px-3 py-2">
                <p className="text-sm text-ink">{row.body}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {shortAuthor(row.author)}
                  {row.ts
                    ? ` · ${new Date(row.ts * 1000).toISOString().replace(".000Z", "Z")}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )
      )}
      <ChatCompose roomId={roomId} onPublicGraph={onPublicGraph} onComposed={onComposed} />
    </div>
  );
}

function ChatCompose({
  roomId,
  onPublicGraph,
  onComposed,
}: {
  roomId: string;
  onPublicGraph: boolean;
  onComposed: (message: ChatMessage, putOnGun: boolean) => void;
}) {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!session) {
    return (
      <p className="mt-3 text-xs text-ink-muted">
        Sign in with Ethereum to send.
      </p>
    );
  }

  const sessionAddress = session.address;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const next = composeChat({
        body,
        roomId,
        address: sessionAddress,
      });
      if (!next) {
        setMessage("Write a short message first.");
        return;
      }
      if (!see?.acl) {
        setMessage("Could not admit this message.");
        return;
      }
      const admitted = admitComposedChat(see.acl, next, sessionAddress);
      if ("denied" in admitted) {
        setMessage("Could not admit this message.");
        return;
      }
      onComposed(admitted.message, onPublicGraph);
      await see.persist();
      setBody("");
      setMessage(
        onPublicGraph
          ? "On this room thread. Seed peer when the socket is up."
          : "On Mine overlay. Not on the public graph until you share this room.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <label className="block text-sm text-ink">
        Message
        <input
          type="text"
          value={body}
          maxLength={CHAT_BODY_MAX}
          onChange={(event) => setBody(event.target.value)}
          placeholder="short message"
          className={`mt-1 w-full ${field}`}
        />
      </label>
      <div className="mt-3">
        <button
          type="button"
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
          className={btnPrimary}
        >
          Send
        </button>
      </div>
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}

function shortAuthor(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
