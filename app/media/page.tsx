import type { Metadata } from "next";
import { PrivateMediaLibrary } from "@/components/PrivateMediaLibrary";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title:"My media — s3r.ch",robots:{index:false,follow:false}};
export default function MediaPage() {
  const tenant=process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;
  return <PrivateMediaLibrary tenant={tenant && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenant) ? tenant : null} />;
}
