import test from "node:test";
import assert from "node:assert/strict";
import { composeRoomMedia, parseRoomMedia, roomMediaText } from "./room-media";
const object='media_p_7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1_22222222222222222222222222222222';
test("room media encodes only one canonical locator",()=>{
  const body=composeRoomMedia(object);assert.ok(body);assert.equal(parseRoomMedia(body),object);
  assert.match(roomMediaText(body),/Private media reference/);assert.equal(roomMediaText("ordinary chat"),"ordinary chat");
});
test("room references reject URLs, keys, extra fields and malformed payloads",()=>{
  for(const value of [null,{},"", "s3rch-media:v2:"+JSON.stringify([object]),"s3rch-media:v1:broken",
    "s3rch-media:v1:"+JSON.stringify([object,"secret"]),"s3rch-media:v1:"+JSON.stringify({object}),
    "s3rch-media:v1:"+JSON.stringify(["https://example.test/file"]),"s3rch-media:v1:"+" ".repeat(513)])assert.equal(parseRoomMedia(value),null);
  for(const value of ["blob:secret","https://storage.test/file",object+"/../x",object.replace("media_","room_"),"media_bad"])assert.equal(composeRoomMedia(value),null);
});
