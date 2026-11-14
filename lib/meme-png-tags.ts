/** Bounded descriptive tags inside the image, encrypted with the ordinary file.
 * PNG tEXt is ancillary; older image readers can ignore it. Tags never grant
 * access. Format: https://www.w3.org/TR/png-3/#11tEXt */
import { normalizeTags } from "./feed-types";
const signature=[137,80,78,71,13,10,26,10],keyword="s3rch-tags";
const encoder=new TextEncoder(),maxBytes=63*1024*1024,maxText=4096;
const table=Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes:Uint8Array){let n=0xffffffff;for(const b of bytes)n=table[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
export function memeTags(input:unknown):string[]{
 if(!Array.isArray(input)||input.length>12||input.some(tag=>typeof tag!=="string"||tag.length>40||!tag.isWellFormed()||/[\u0000-\u001f\u007f]/.test(tag)))throw Error("Use up to 12 tags of 40 characters each.");
 return normalizeTags(input);
}
function chunks(bytes:Uint8Array){
 if(!(bytes instanceof Uint8Array)||bytes.length>maxBytes||bytes.length<45||!signature.every((b,i)=>bytes[i]===b))throw Error("Invalid PNG");
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),result:{at:number;end:number;type:string;data:Uint8Array}[]=[];
 let at=8;
 while(at+12<=bytes.length&&result.length<1024){
  const size=view.getUint32(at),end=at+12+size;
  if(end>bytes.length)throw Error("Invalid PNG chunk");
  const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
  if(!/^[A-Za-z]{4}$/.test(type))throw Error("Invalid PNG chunk");
  result.push({at,end,type,data:bytes.subarray(at+8,end-4)});at=end;
  if(type==="IEND")break;
 }
 if(at!==bytes.length||result[0]?.type!=="IHDR"||result[0].data.length!==13||result.at(-1)?.type!=="IEND"||result.at(-1)!.data.length!==0)throw Error("Invalid PNG structure");
 return result;
}
const ours=(row:{type:string;data:Uint8Array})=>row.type==="tEXt"&&row.data.length>keyword.length&&
 [...keyword].every((c,i)=>row.data[i]===c.charCodeAt(0))&&row.data[keyword.length]===0;
export function tagMemePng(bytes:Uint8Array,input:unknown):Uint8Array{
 const tags=memeTags(input),rows=chunks(bytes);
 const json=JSON.stringify({version:1,tags}).replace(/[^\x20-\x7e]/g,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0"));
 const data=encoder.encode(keyword+"\0"+json);if(data.length>maxText)throw Error("Tags too large");
 const chunk=new Uint8Array(data.length+12),view=new DataView(chunk.buffer);
 view.setUint32(0,data.length);chunk.set(encoder.encode("tEXt"),4);chunk.set(data,8);view.setUint32(chunk.length-4,crc(chunk.subarray(4,chunk.length-4)));
 const retained=rows.filter(row=>!ours(row));const length=8+chunk.length+retained.reduce((n,row)=>n+row.end-row.at,0);
 if(length>maxBytes)throw Error("PNG too large");
 const output=new Uint8Array(length);output.set(signature);let offset=8;
 for(const row of retained){if(row.type==="IEND"){output.set(chunk,offset);offset+=chunk.length;}output.set(bytes.subarray(row.at,row.end),offset);offset+=row.end-row.at;}
 return output;
}
/** Malformed or unrelated image metadata cannot prevent ordinary file playback. */
export function readMemePngTags(bytes:Uint8Array):readonly string[]{
 try{
  const rows=chunks(bytes).filter(ours);if(rows.length!==1||rows[0].data.length>maxText)return [];
  const row=rows[0],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(row.end-4)!==crc(bytes.subarray(row.at+4,row.end-4)))return [];
  const text=row.data.subarray(keyword.length+1);if(text.some(b=>b<32||b>126))return [];
  const value=JSON.parse(new TextDecoder().decode(text));
  if(!value||Object.keys(value).sort().join()!=="tags,version"||value.version!==1)return [];
  return Object.freeze(memeTags(value.tags));
 }catch{return [];}
}
