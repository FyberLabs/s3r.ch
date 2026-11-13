import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mediaPreviewKind } from "./media-preview";
import { PrivateMediaPreview } from "../components/PrivateMediaPreview";
test("private player only accepts the supported inert media labels",()=>{
  for(const [kind,types] of [["image",["png","jpeg","gif","webp","avif"]],["audio",["mpeg","ogg","wav","webm","mp4"]],["video",["mp4","webm","ogg"]]] as const)
    for(const type of types)assert.equal(mediaPreviewKind(kind+"/"+type),kind);
  for(const type of ["text/html","image/svg+xml","application/javascript","video/mp4; charset=utf-8","IMAGE/PNG",""])
    assert.equal(mediaPreviewKind(type),null);
});
test("audio and video are controlled temporary players without autoplay",()=>{
  for(const kind of ["audio","video"]) {
    const html=renderToStaticMarkup(createElement(PrivateMediaPreview,{preview:{url:"blob:private",name:"private <clip>",mediaType:kind+"/mp4"}}));
    assert.match(html,new RegExp("<"+kind+" "));assert.match(html,/controls=""/);assert.match(html,/preload="metadata"/);
    assert.match(html,/src="blob:private"/);assert.match(html,/private &lt;clip&gt;/);assert.doesNotMatch(html,/autoplay/i);
  }
});
test("image previews retain escaped labels and refuse remote or active content",()=>{
  const preview={url:"blob:private",name:"Photo",mediaType:"image/png"};
  assert.match(renderToStaticMarkup(createElement(PrivateMediaPreview,{preview})),/<img[^>]+alt="Photo"/);
  for(const bad of [{...preview,url:"https://tracker.example/photo"},{...preview,url:"data:image/png;base64,AAAA"},
    {...preview,mediaType:"image/svg+xml"}])assert.equal(renderToStaticMarkup(createElement(PrivateMediaPreview,{preview:bad})),"");
});
