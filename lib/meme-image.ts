/** Local raster drafts only. No network, persistence, grants or post publication. */
export const MEME_FILE_MAX = 8 * 1024 * 1024;
export const MEME_DIMENSION_MAX = 4096;
export const MEME_CAPTION_MAX = 160;
export type MemeLayout = "overlay" | "panel";
export function rasterDimensions(bytes: Uint8Array): {width:number;height:number;type:string} {
  if (!bytes.length || bytes.length > MEME_FILE_MAX) throw Error("Choose a PNG or JPEG up to 8 MiB.");
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let width=0,height=0,type="";
  if(bytes.length>=24 && [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n) && view.getUint32(8)===13 && view.getUint32(12)===0x49484452){
    width=view.getUint32(16);height=view.getUint32(20);type="image/png";
  } else if(bytes[0]===255 && bytes[1]===216){
    let at=2;
    while(at+4<=bytes.length){
      if(bytes[at++]!==255)break;
      while(at<bytes.length && bytes[at]===255)at++;
      const marker=bytes[at++];
      if(marker===218 || marker===217)break;
      if(at+2>bytes.length)break;
      const length=view.getUint16(at);
      if(length<2 || at+length>bytes.length)break;
      if([192,193,194].includes(marker) && length>=8){height=view.getUint16(at+3);width=view.getUint16(at+5);type="image/jpeg";break;}
      at+=length;
    }
  }
  if(!type || !width || !height || width>MEME_DIMENSION_MAX || height>MEME_DIMENSION_MAX)
    throw Error("Choose a PNG or JPEG no larger than 4096 × 4096 pixels.");
  return {width,height,type};
}
export function captionLines(text:string,width:number,measure:(text:string)=>number):string[] {
  if(typeof text!=="string" || text.length>MEME_CAPTION_MAX || !text.isWellFormed() || /[\u0000-\u001f\u007f]/.test(text))throw Error("Use a single caption up to 160 characters.");
  const lines:string[]=[];let line="";
  for(const character of Array.from(text.trim())){
    if(measure(character)>width)throw Error("Shorten the caption or choose a larger image.");
    if(line && measure(line+character)>width){lines.push(line.trimEnd());line="";}
    if(!line && character===" ")continue;
    line+=character;
  }
  if(line.trim())lines.push(line.trim());
  return lines;
}
export function drawMeme(canvas:HTMLCanvasElement,image:ImageBitmap|null,top:string,bottom:string,layout:MemeLayout,background:"dark"|"light") {
  if(layout!=="overlay"&&layout!=="panel" || background!=="dark"&&background!=="light")throw Error("Unknown template.");
  const originalWidth=image?.width??1280,originalHeight=image?.height??720;
  if(!originalWidth||!originalHeight||originalWidth>4096||originalHeight>4096)throw Error("Image dimensions are unsupported.");
  const scale=Math.min(1,1600/originalWidth,1600/originalHeight),w=Math.round(originalWidth*scale),h=Math.round(originalHeight*scale);
  const panel=layout==="panel"?Math.max(100,Math.round(h*.35)):0;
  canvas.width=w;canvas.height=h+panel;
  const ctx=canvas.getContext("2d");if(!ctx)throw Error("Image editing is unavailable in this browser.");
  ctx.fillStyle=background==="dark"?"#142538":"#e6edf5";ctx.fillRect(0,0,w,h+panel);
  if(image)ctx.drawImage(image,0,panel,w,h);
  if(panel){ctx.fillStyle="#ffffff";ctx.fillRect(0,0,w,panel);}
  const margin=Math.max(8,w*.04),space=panel||h*.34;
  function caption(text:string,position:"top"|"bottom") {
    let size=Math.max(12,Math.min(72,w*.07)),lines:string[]=[];
    for(;;){ctx.font=`bold ${size}px Arial, sans-serif`;lines=captionLines(text,w-2*margin,t=>ctx.measureText(t).width);
      if(lines.length*size*1.2<=space-2*margin)break;
      size-=2;if(size<10)throw Error("Shorten the caption or choose a larger image.");}
    ctx.textAlign="center";ctx.textBaseline="top";ctx.lineJoin="round";ctx.lineWidth=Math.max(2,size/12);
    ctx.fillStyle=panel&&position==="top"?"#111111":"#ffffff";ctx.strokeStyle="#111111";
    const y=position==="top"?margin:canvas.height-margin-lines.length*size*1.2;
    lines.forEach((line,i)=>{if(!(panel&&position==="top"))ctx.strokeText(line,w/2,y+i*size*1.2);ctx.fillText(line,w/2,y+i*size*1.2);});
  }
  caption(top,"top");caption(bottom,"bottom");
}
