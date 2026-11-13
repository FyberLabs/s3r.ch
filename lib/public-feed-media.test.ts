import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import PublicFeedMedia from "../components/PublicFeedMedia";
const render=(media:unknown)=>renderToStaticMarkup(createElement(PublicFeedMedia,{media}));
test("sensitive media has no remote or proxy element before explicit reveal",()=>{
 const html=render([{kind:"image",url:"https://example.com/private.png",sensitive:true,warning:"Spoiler"}]);
 assert.match(html,/Spoiler/);assert.match(html,/Show media/);assert.doesNotMatch(html,/<img|src=|example.com|\/api\/feed/);
});
test("public players use only local proxy URLs without autoplay",()=>{
 for(const kind of ["image","audio","video"]){
  const html=render([{kind,url:"https://example.com/a",alt:"Accessible <label>"}]);
  assert.match(html,/src="\/api\/feed\/media\?/);assert.doesNotMatch(html,/src="https:|autoplay/i);
  assert.match(html,/Accessible &lt;label&gt;/);
  if(kind!=="image"){assert.match(html,/controls=""/);assert.match(html,/preload="none"/);}
 }
});
test("link and quote cards escape content and unknown URLs refuse",()=>{
 for(const kind of ["link","quote"])assert.match(render([{kind,url:"https://example.com/a",text:"<script>"}]),/&lt;script&gt;/);
 assert.equal(render([{kind:"image",url:"javascript:alert(1)"}]),"");
});
