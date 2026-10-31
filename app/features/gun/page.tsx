import type { Metadata } from "next";
import { FeatureArticle, FeatureSection } from "@/components/FeatureArticle";

export const metadata: Metadata = {
  title: "Gun graph — s3r.ch",
  description:
    "How s3r.ch uses Gun: a seed peer, browser peers, share and unshare, and room chat that stays with its holders.",
};

export default function GunFeaturePage() {
  return (
    <FeatureArticle
      title="How s3r.ch uses Gun"
      lede="Shared posts, rooms, and room chat live on a Gun graph. Peers pass updates to each other, and a shared item stays available while someone still holds it."
      actions={[
        { href: "/feed", label: "Open feed" },
        { href: "/forum", label: "Open forum", tone: "secondary" },
        { href: "/features/sociacl", label: "SociACL", tone: "secondary" },
      ]}
    >
      <FeatureSection title="A seed peer, then your browser">
        <p>
          Open the feed and s3r.ch shows a public snapshot from a seed peer, so
          the page can already have posts. Your browser connects to that seed
          and, when it can, to other browsers. The seed is one peer in the graph.
        </p>
      </FeatureSection>

      <FeatureSection title="Share and unshare">
        <p>
          Share writes your post or room onto the graph. Unshare writes a removal
          for that item. Readers that see the removal drop it. A removal reaches
          peers as they sync.
        </p>
      </FeatureSection>

      <FeatureSection title="Rooms and chat">
        <p>
          Room titles, chat, and presence travel on Gun for a room you can see.
          You sign in to send a message or announce that you are there.
        </p>
      </FeatureSection>

      <FeatureSection title="What stays">
        <p>
          A shared item stays available while some peer still holds it. Save your
          own copy of anything you need to keep.
        </p>
        <p>
          Forum channels are kept for their owner by this site. Those posts and
          desktop snapshots can disappear when the site restarts. Room chat stays
          with the Gun peers who hold it.
        </p>
      </FeatureSection>
    </FeatureArticle>
  );
}