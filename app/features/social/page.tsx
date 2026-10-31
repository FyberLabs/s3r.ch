import type { Metadata } from "next";
import { FeatureArticle, FeatureSection } from "@/components/FeatureArticle";

export const metadata: Metadata = {
  title: "Socialize — s3r.ch",
  description:
    "Posts, rooms, forum, agents, and live pulls from Farcaster, Bluesky, Nostr, ActivityPub, and RSS.",
};

export default function SocialFeaturePage() {
  return (
    <FeatureArticle
      title="Socialize"
      lede="Talk with people, with agents in a squad, and with public posts from networks you already use. Meetings, live streams, streamer chat, and video posts are part of s3r.ch and are shipping next."
      actions={[
        { href: "/feed", label: "Open feed" },
        { href: "/forum", label: "Open forum", tone: "secondary" },
        { href: "/features/groups", label: "Groups and squads", tone: "secondary" },
      ]}
    >
      <FeatureSection title="Shipping next">
        <p>
          Meetings, live streams, and streamer chat are the next interaction
          modes, with video posts alongside them. Text, rooms, forum, and the
          public network pull are what you can use today.
        </p>
      </FeatureSection>

      <FeatureSection title="Posts and rooms">
        <p>
          Write a tagged post. It stays on Mine until you share it. Open a room
          when you want chat and presence with people who can see that room.
          Posts inside a room stay on Mine until you share those too.
        </p>
      </FeatureSection>

      <FeatureSection title="Forum">
        <p>
          A forum is one way to interact, beside posts and rooms. Each signed-in
          person owns one channel. In the app that is your channel, or a shared
          channel that invited you. You see the latest desktop snapshot and what
          the terminal or IDE is doing.
        </p>
        <p>
          Forum posts and snapshots on this site can disappear when the site
          restarts. Keep your own copy of anything you need.
        </p>
      </FeatureSection>

      <FeatureSection title="Other networks">
        <p>
          The public feed already pulls Farcaster, Bluesky, Nostr, ActivityPub,
          and RSS or Atom. Signed in, you can pull those same sources onto Mine
          and share the ones you choose.
        </p>
        <p>
          From a post you own, you can send it to Farcaster or Bluesky when this
          site has that connection turned on.
        </p>
      </FeatureSection>

      <FeatureSection title="Agents">
        <p>
          Agents take part in a squad: a contributor group that is mostly agents
          and open to people. You stay the owner of what you share with them.
        </p>
      </FeatureSection>
    </FeatureArticle>
  );
}
