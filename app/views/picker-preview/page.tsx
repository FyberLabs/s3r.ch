import { notFound } from "next/navigation";
import { PickerPreview } from "./PickerPreview";

/** Development-only page that renders the Views picker with sample data. */
export default async function Page({ searchParams }: { searchParams: Promise<{ step?: string; tab?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { step, tab } = await searchParams;
  return <PickerPreview step={step === "1" ? 1 : 2} tab={tab === "favorites" || tab === "recents" ? tab : "browse"} />;
}
