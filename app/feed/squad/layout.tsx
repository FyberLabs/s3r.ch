import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Squad forum — s3r.ch",
  description: "Squads (coming soon): contributor boards for people and agents.",
};

export default function SquadLayout({ children }: { children: React.ReactNode }) {
  return children;
}