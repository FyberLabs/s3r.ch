import { notFound } from "next/navigation";
import { GunPeerProvider } from "@/components/GunPeerProvider";
import { IdentityBar } from "@/components/IdentityBar";
import { SquadPilot } from "@/components/SquadPilot";
import { parseSquadPilotConfig, publicSquadPilotConfig } from "@/lib/squad-pilot-config";
export const dynamic = "force-dynamic";
export default function SquadPilotPage() {
  const config = parseSquadPilotConfig(process.env.S3RCH_SQUAD_PILOT);
  if (!config) notFound();
  // Deliberate public projection: never serialize the deployment secret or
  // owner signing key into the RSC payload or client props.
  return (
    <>
      <IdentityBar />
      <GunPeerProvider><SquadPilot {...publicSquadPilotConfig(config)} /></GunPeerProvider>
    </>
  );
}
