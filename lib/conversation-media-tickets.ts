export function parseConversationTickets(value:unknown):Record<string,string>{
 if(value===undefined)return {};
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid media tickets");
 const entries=Object.entries(value);if(entries.length>400)throw Error("Too many media tickets");
 const result:Record<string,string>={};
 for(const [key,ticket] of entries){
  if(key.length>2200||!/^(image|audio|video)\0https?:\/\//.test(key)||typeof ticket!=="string"||!/^[a-f0-9]{64}\.[a-f0-9]{64}\.\d{1,16}\.[a-f0-9]{64}$/.test(ticket))throw Error("Invalid media ticket");
  result[key]=ticket;
 }
 return result;
}
