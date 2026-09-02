"use client";

import { useState } from "react";
import { admitNativePost, composeNativePost } from "@/lib/compose";
import type { FeedItem } from "@/lib/feed-types";
import { splitTags } from "@/lib/feed-types";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";

export function ComposeForm({
  onItem,
}: {
  onItem: (item: FeedItem) => void;
}) {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!session) {
    return (
      <p className="mt-10 text-xs text-gray-500">
        Sign in with Ethereum to post.
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
        tags: splitTags(tagsInput),
      });
      if (!item) {
        setMessage("Write something first.");
        return;
      }
      if (!see?.acl) {
        setMessage("Could not admit this post.");
        return;
      }
      const admitted = admitNativePost(see.acl, item, sessionAddress);
      if ("denied" in admitted) {
        setMessage("Could not admit this post.");
        return;
      }
      onItem(admitted.item);
      await see.persist();
      setBody("");
      setTagsInput("");
      setMessage("On Mine. Not public until you share.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-10 rounded-xl border border-brand-100 bg-brand-50/40 p-5">
      <h2 className="text-sm font-semibold text-brand-900">Compose</h2>
      <p className="mt-2 text-sm text-gray-600">
        Native s3r.ch post. Stays on Mine until you share to public. A see-grant
        is not that share. This is not an outbound bridge.
      </p>
      <label className="mt-4 block text-sm text-gray-700">
        Body
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-brand-100 bg-white px-3 py-2 text-sm"
        />
      </label>
      <label className="mt-3 block text-sm text-gray-700">
        Tags
        <input
          type="text"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
          placeholder="optional, comma-separated"
          className="mt-1 w-full rounded-lg border border-brand-100 bg-white px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-3">
        <button
          type="button"
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          Post to Mine
        </button>
      </div>
      {message ? <p className="mt-3 text-xs text-gray-500">{message}</p> : null}
    </div>
  );
}
