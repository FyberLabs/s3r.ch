"use client";

import { useState } from "react";
import {
  admitComposedChat,
  CHAT_BODY_MAX,
  composeChat,
  rankChatMessages,
  type ChatMessage,
} from "@/lib/chat";
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

  return (
    <div className={`mt-6 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Live chat</h2>
      <p className="mt-2 text-xs text-ink-muted">
        Short messages on this room thread. Presence and WebRTC are later.
        Trying seed peer; if the socket is down this list can be empty or
        local only. There is no hosted transcript.
        {onPublicGraph
          ? seedWsUp
            ? " This room node is on the public graph. New messages go through the seed peer when the socket is up."
            : " This room node is on the public graph. Snapshot is not a chat log."
          : " This room is Mine. Chat stays on your overlay until you share the room node. Sharing the room does not publish Mine posts inside it."}
      </p>
      {listed.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          {onPublicGraph
            ? "No chat in this room yet."
            : "No local chat in this room yet."}
        </p>
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
        Sign in with Ethereum to send. Unsigned visitors can read chat when
        this room node is on the public graph. A see-grant is not delivery.
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
