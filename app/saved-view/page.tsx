import type { Metadata } from "next";
import { SavedViewLink } from "./SavedViewLink";

export const metadata: Metadata = {
  title: "View — s3r.ch",
  description: "A saved View: your chosen sources in split windows.",
};

export default function Page() {
  return <SavedViewLink />;
}
