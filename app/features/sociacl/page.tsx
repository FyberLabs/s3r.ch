import type { Metadata } from "next";
import { FeatureArticle, FeatureSection } from "@/components/FeatureArticle";

export const metadata: Metadata = {
  title: "SociACL — s3r.ch",
  description:
    "SociACL on s3r.ch: your wallet owns what you write, Mine until you share, see-grants you can revoke, and held claims.",
};

export default function SociaclFeaturePage() {
  return (
    <FeatureArticle
      title="SociACL"
      lede="SociACL is how s3r.ch decides who owns something and who else may see it. You hold the keys. You choose what leaves Mine."
      actions={[
        { href: "/feed", label: "Open feed" },
        { href: "/features/gun", label: "How Gun works", tone: "secondary" },
        { href: "/features/groups", label: "Groups", tone: "secondary" },
      ]}
    >
      <FeatureSection title="You are the owner">
        <p>
          Sign in with a wallet. That address owns what you write. A mesh key on
          this browser is the identity the graph uses for you. Hypermesh and the
          other accounts you continue with attach to that wallet.
        </p>
      </FeatureSection>

      <FeatureSection title="Mine until you share">
        <p>
          New posts, rooms, and claims start on Mine. Share a post or a room
          when you want it on the public feed. Unshare removes your copy from
          the public graph. People who already saved it can still have their copy.
        </p>
      </FeatureSection>

      <FeatureSection title="See, then revoke">
        <p>
          Grant see to an address for a claim you hold. They receive it under
          Granted. Revoke ends that grant. You can grant see without publishing
          the claim to everyone.
        </p>
      </FeatureSection>

      <FeatureSection title="Held claims">
        <p>
          A name, and other claims you confirm, stay held until you share that
          claim. Sharing your name leaves the rest held.
        </p>
      </FeatureSection>

      <FeatureSection title="The shared graph stays with its holders">
        <p>
          Shared posts and rooms live with the peers who still hold them. The
          site runs a seed peer so you can catch up. Keep your own copy of
          anything you still need if those holders drop it.
        </p>
      </FeatureSection>
    </FeatureArticle>
  );
}
