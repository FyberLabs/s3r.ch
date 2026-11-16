"use client";
import Link from "next/link";
import { ForumShell as SharedForumShell, type ForumShellProps } from "../packages/forum-ui/src/ForumShell";
export type { ForumTab } from "../packages/forum-ui/src/ForumShell";
export function ForumShell(props: Omit<ForumShellProps, "forumLink">) {
  return <SharedForumShell {...props} forumLink={<Link href={props.forum.href} aria-current="page"
    className="mt-2 block font-semibold text-ink hover:text-signal">{props.forum.label}</Link>} />;
}
