import { getVaultApiService } from '@/lib/vault-api-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  try{const service=getVaultApiService();if(service)return await service(request);}catch{/* Never expose private storage configuration. */}
  return new Response(null,{status:503,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
