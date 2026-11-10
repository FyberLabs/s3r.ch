import type { Metadata } from "next";
import { FeatureArticle, FeatureSection } from "@/components/FeatureArticle";

export const metadata: Metadata = {
  title: "SociACL — s3r.ch",
  description:
    "Your s3r.ch identity is a public key you hold. Wallets and sign-ins are linked credentials. Posts start on Mine until you share them.",
};

export default function SociaclFeaturePage() {
  return (
    <FeatureArticle
      title="SociACL"
      lede="SociACL is how s3r.ch decides who can see something. Your identity is a public key this browser holds. You choose what leaves Mine."
      actions={[
        { href: "/feed", label: "Open feed" },
        { href: "/features/gun", label: "How Gun works", tone: "secondary" },
        { href: "/features/groups", label: "Groups", tone: "secondary" },
      ]}
    >
      <FeatureSection title="Your identity">
        <p>
          After you sign in, this browser holds a public key. That key is your
          identity on the graph. A wallet, and Microsoft, GitHub, Google, or
          Hypermesh when that sign-in is turned on, are linked credentials. They
          do not create a second identity. A paper backup or a device passkey
          can recover the same key. The first sign-in asks you to confirm you
          are 18 or older.
        </p>
        <p>
          Coming in v1, every part of s3r.ch keys on that public key, and an
          agent gets a short-lived token delegated from it, with an audience,
          scopes, and an expiry. Today a forum token lets a headless agent read
          and post in your forum as you.
        </p>
      </FeatureSection>

      <FeatureSection title="Mine until you share">
        <p>
          New posts, rooms, and claims start on Mine. Share a post or a room
          when you want it on the public feed. Unshare takes it off the public
          graph. s3r.ch utilizes public posts to improve services. Deleted
          public posts are not kept. Readers drop a removal when they sync.
          Someone who already saved a copy can still have that copy.
        </p>
      </FeatureSection>

      <FeatureSection title="See, then revoke">
        <p>
          Grant see to one address, for a time window you set, on a claim or a
          post of yours. They receive it under Granted. Revoke ends that grant.
          You can grant see without publishing the claim to everyone.
        </p>
      </FeatureSection>

      <FeatureSection title="Claims you have not shared">
        <p>
          A name, and other claims you confirm, stay on your account until you
          share that claim. ENS and Unstoppable names, and Farcaster, Lens, and
          RSS3 footprints, can sit there after sign-in, along with email and
          phone when you confirm them. Sharing your name leaves the rest
          unshared.
        </p>
      </FeatureSection>

      <FeatureSection title="The shared graph stays with its peers">
        <p>
          Shared posts and rooms live with the peers who still have them. The
          site runs a seed peer so you can catch up. Keep your own copy of
          anything you still need if those peers drop it.
        </p>
      </FeatureSection>
    </FeatureArticle>
  );
}
