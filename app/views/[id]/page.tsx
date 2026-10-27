import type { Metadata } from "next";
import { ViewRoute } from "@/components/ViewRoute";

export const metadata: Metadata = {
  title: "View — s3r.ch",
  description: "A saved View: your chosen sources in split windows.",
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ViewRoute id={id} />;
}
