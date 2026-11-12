import type { Metadata } from "next";
import { ToolRegistry } from "@/components/ToolRegistry";
export const metadata: Metadata = { title: "Tools — s3r.ch", description: "Web and local tool listings, separate from permission to use them." };
export default function ToolsPage() { return <ToolRegistry />; }
