import {getContactService} from '@/lib/contact-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{action:string}>}){
  try{const {action}=await context.params;const service=getContactService();if(service)return await service(action,request);}catch{/* Keep private binding details server-side. */}
  return new Response(null,{status:503,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
