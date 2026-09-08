"use client";

import { useState } from "react";
import { admitNativePost, composeNativePost } from "@/lib/compose";
import type { FeedItem } from "@/lib/feed-types";
import { splitTags } from "@/lib/feed-types";
import { roomTag } from "@/lib/rooms";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import { btnPrimary, field, panel } from "@/lib/brand-ui";

export function ComposeForm({
  onItem,
  roomId,
}: {
  onItem: (item: FeedItem) => void;
  roomId?: string;
}) {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!session) {
    return (
      <p className="mt-10 text-xs text-ink-muted">
        Sign in to post.
      </p>
    );
  }

  const sessionAddress = session.address;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const item = composeNativePost({
        body,
        address: sessionAddress,
        tags: [
          ...splitTags(tagsInput),
          ...(roomId ? [roomTag(roomId)] : []),
        ],
      });
      if (!item) {
        setMessage("Write something first.");
        return;
      }
      if (!see?.acl) {
        setMessage("Could not save this post.");
        return;
      }
      const admitted = admitNativePost(see.acl, item, sessionAddress);
      if ("denied" in admitted) {
        setMessage("Could not save this post.");
        return;
      }
      onItem(admitted.item);
      await see.persist();
      setBody("");
      setTagsInput("");
      setMessage("Saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mt-10 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">
        {roomId ? "Compose into this room" : "Compose"}
      </h2>
      <label className="mt-4 block text-sm text-ink">
        Body
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          className={`mt-1 w-full ${field}`}
        />
      </label>
      <label className="mt-3 block text-sm text-ink">
        Tags
        <input
          type="text"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
          placeholder="optional, comma-separated"
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
          Post to Mine
        </button>
      </div>
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
