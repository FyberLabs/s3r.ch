import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import {deviceServer} from '@/lib/identity/device-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{action:string}>};
async function nativeGET(request:Request,context:Context){return deviceServer(request,(await context.params).action);}
async function nativePOST(request:Request,context:Context){return deviceServer(request,(await context.params).action);}

export const GET = withConfiguredTerminalHandler(nativeGET);
export const POST = withConfiguredTerminalHandler(nativePOST);
