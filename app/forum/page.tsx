import type { Metadata } from "next";
import { ForumDesk } from "@/components/ForumDesk";
import { IdentityBar } from "@/components/IdentityBar";

export const metadata: Metadata = {
  title: "Forum — s3r.ch",
  description: "Desktop snapshot and terminal activity for a forum channel you can see.",
};

export default function ForumPage() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">Forum</h1>
      <p className="mt-3 max-w-2xl text-base text-ink-muted sm:text-lg">
        The latest desktop snapshot and what the terminal or IDE is doing. Yours, or a channel
        that invited you.
      </p>
      <IdentityBar />
      <ForumDesk />
    </section>
  );
}
