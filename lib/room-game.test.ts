import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canPlayRoomGame, composeRoomGame, parseRoomGameAction, roomGameChatText, roomGames, type RoomGameAction } from "./room-game";
import { admitComposedChat, preparePublishRoomChat, type ChatMessage } from "./chat";
import { applySeeGrant, roomSoul } from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import { composeRoom } from "./rooms";

const X = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const O = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const room = composeRoom({title:"Game room",address:X,nowSeconds:100,entropy:"aabb"})!.id;
function event(author: string, action: RoomGameAction, at=100): ChatMessage {
  const message=composeRoomGame(room,author,action,at); assert.ok(message); return message;
}
function setup() {
  const rows=[event(X,["start"])], id=rows[0].id;
  rows.push(event(O,["join",id,id]));
  const view=()=>roomGames(rows,room)[0];
  const move=(author:string,cell:number)=>rows.push(event(author,["move",id,view().head,cell]));
  return {rows,id,view,move};
}

describe("Room game chat protocol",()=>{
  it("plays a complete game, retains it on reload, and rejects moves after the result",()=>{
    const h=setup();
    for(const [who,cell] of [[X,0],[O,3],[X,1],[O,4],[X,2]] as const) h.move(who,cell);
    assert.equal(h.view().outcome,"X");
    const done=h.view();h.move(O,8);
    assert.deepEqual(h.view(),done);
    assert.deepEqual(roomGames([...h.rows].reverse(),room)[0],done);
    assert.deepEqual(roomGames(JSON.parse(JSON.stringify(h.rows)),room)[0],done);
  });
  it("draws and detects column and diagonal wins",()=>{
    for(const [cells,result] of [[[0,1,2,4,3,5,7,6,8],"draw"],[[0,1,3,2,6],"X"],[[0,1,4,2,8],"X"]] as const){
      const h=setup();cells.forEach((cell,index)=>h.move(index%2?O:X,cell));assert.equal(h.view().outcome,result);
    }
  });
  it("requires two distinct players, correct turns, empty cells and the current predecessor",()=>{
    const start=event(X,["start"]), rows=[start,event(X,["join",start.id,start.id])];
    assert.equal(roomGames(rows,room)[0].o,null);
    const h=setup();const before=h.view();h.move(O,0);h.move(OTHER,1);assert.deepEqual(h.view(),before);
    h.move(X,0);const moved=h.view();h.move(O,0);assert.deepEqual(h.view(),moved);
    h.rows.push(event(O,["move",h.id,before.head,2]));assert.deepEqual(h.view(),moved);
    h.rows.push(event(OTHER,["join",h.id,moved.head]));assert.deepEqual(h.view(),moved);
  });
  it("waits for missing parents and resolves concurrent valid siblings independently of arrival order",()=>{
    const h=setup();const prior=h.view().head;
    const a=event(X,["move",h.id,prior,0]), b=event(X,["move",h.id,prior,1]);
    const selected=a.id<b.id?a:b;
    const reply=event(O,["move",h.id,selected.id,4]);
    assert.deepEqual(roomGames([...h.rows,reply],room)[0].board,Array(9).fill(null));
    const expected=roomGames([...h.rows,a,b,reply],room);
    assert.deepEqual(roomGames([reply,b,...h.rows,a],room),expected);
    assert.equal(expected[0].head,reply.id);assert.equal(expected[0].board[4],"O");
  });
  it("separates rooms and sessions, rejects conflicting IDs, malformed records and forged author/ID pairs",()=>{
    const h=setup(), other=event(OTHER,["start"],101);
    assert.equal(roomGames([...h.rows,{...other,room:"another-room"}],room).length,1);
    assert.equal(roomGames([...h.rows,{...other,author:X}],room).length,1);
    assert.equal(roomGames([...h.rows,{...other,v:999}],room).length,1);
    assert.equal(roomGames([...h.rows,{...other,ts:NaN}],room).length,1);
    const conflicting={...h.rows[0],body:"s3rch-game:v1:[\"move\",\"bad\",\"bad\",0]"};
    // Malformed chat cannot inject a valid event or move.
    assert.equal(roomGames([...h.rows,conflicting],room)[0].head,h.view().head);
    const conflict={...h.rows[0],ts:101};
    assert.deepEqual(roomGames([...h.rows,conflict],room),[]);
    assert.equal(roomGames([...h.rows,other],room).length,2);
    assert.equal(roomGames([h.rows[0]],room)[0].o,null);
  });
  it("keeps messages bounded and renders understandable chat summaries",()=>{
    const h=setup();h.move(X,0);
    for(const row of h.rows){assert.ok(row.body.length<=280);assert.ok(parseRoomGameAction(row.body));}
    assert.equal(roomGameChatText(h.rows[0].body),"Started a tic-tac-toe game.");
    assert.equal(roomGameChatText(h.rows[1].body),"Joined a tic-tac-toe game.");
    assert.equal(roomGameChatText(h.rows[2].body),"Tic-tac-toe move: square 1.");
    assert.equal(roomGameChatText("ordinary chat"),"ordinary chat");
    for(const body of [null,{},"s3rch-game:v2:[\"start\"]","s3rch-game:v1:{}","s3rch-game:v1:[\"start\",1]","s3rch-game:v1:[", "x".repeat(281)]) assert.equal(parseRoomGameAction(body),null);
    for(const cell of [-1,9,1.5]) assert.equal(composeRoomGame(room,X,["move",h.id,h.view().head,cell]),null);
    assert.equal(composeRoomGame(room,"invalid",["start"]),null);
  });
  it("uses existing room/message admission and never publishes Mine-only game events",()=>{
    const acl=createMemorySeeAcl(), message=event(X,["start"]);
    assert.ok("denied" in preparePublishRoomChat(acl,message,X,[]));
    assert.ok("denied" in admitComposedChat(createMemorySeeAcl(),{...message,v:99},X));
    assert.ok(!("denied" in preparePublishRoomChat(acl,message,X,[room])));
    assert.equal(canPlayRoomGame(acl,room,X,100),false);
    acl.putObject(roomSoul(room),X);
    assert.equal(canPlayRoomGame(acl,room,X,100),true);
    assert.equal(canPlayRoomGame(acl,room,O,100),false);
    applySeeGrant(acl,X,{claimId:roomSoul(room),accessor:O,from:100,until:200});
    assert.equal(canPlayRoomGame(acl,room,O,150),true);
    assert.equal(canPlayRoomGame(acl,room,O,200),false);
  });
});
