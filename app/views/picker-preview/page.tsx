import { notFound } from "next/navigation";
import { PickerPreview, ScreenPage, WindowsPage } from "./PickerPreview";

/** Development-only page that renders the Views picker with sample data. */
export default async function Page({ searchParams }: { searchParams: Promise<{ step?: string; tab?: string; states?: string; windows?: string; screen?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { step, tab, states, windows, screen } = await searchParams;
  if (screen === "1") return <ScreenPage />;
  if (windows === "1") return <WindowsPage />;
  return <PickerPreview step={step === "1" ? 1 : 2} tab={tab === "favorites" || tab === "recents" ? tab : "browse"} states={states === "1"} />;
}
