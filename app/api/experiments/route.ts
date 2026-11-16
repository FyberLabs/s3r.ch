import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { s3rchExperimentRequest } from "@/lib/experiment-application";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";



export const GET = withConfiguredTerminalHandler(s3rchExperimentRequest);
export const POST = withConfiguredTerminalHandler(s3rchExperimentRequest);
