/// <reference lib="webworker" />
import { BackendCore, plaintextCipher } from "@terno/backend/portable";
import { IdbMailStore } from "@terno/idb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { isRpcMessage, type RpcMessage } from "@terno/core/rpc";
import { createBrowserIncomingProcessor } from "../../../src/web/worker/incoming-runtime";
declare const self: DedicatedWorkerGlobalScope;
let files=1001, backend:BackendCore;
const api="https://gmail.googleapis.com/gmail/v1/users/me";
function resource(id:string){
  const parts=Array.from({length:id==="p"?files:1},(_,i)=>`--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${i}.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAP+ADQo=`);
  const raw=["From: sender@example.test","Subject: Synthetic",`Message-ID: <${id}@example.test>`,"Content-Type: multipart/mixed; boundary=b","","--b","Content-Type: text/plain","",`Exact ${id}`,...parts,"--b--",""].join("\r\n");
  return {id,threadId:id,labelIds:["INBOX"],internalDate:"1",raw:btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")};
}
// Native fetchGoogle Request interception precedes Backend; every unlisted request is refused.
self.fetch=async(input,init)=>{
  if(!(input instanceof Request)||init!==undefined||input.method!=="GET"||input.headers.get("authorization")!=="Bearer synthetic")throw new Error("Unexpected synthetic request");
  const u=new URL(input.url);if(u.origin!==new URL(api).origin)throw new Error("Unexpected synthetic origin");
  const path=u.pathname.slice(new URL(api).pathname.length);
  if(path==="/profile"&&!u.search)return Response.json({emailAddress:"me@example.test",historyId:"100"});
  if(path==="/labels"&&!u.search)return Response.json({labels:[]});
  if(path==="/messages"&&u.searchParams.get("maxResults")==="500")return Response.json({messages:[{id:"p"},{id:"g"}]});
  if(path==="/history"&&u.searchParams.get("startHistoryId")==="100")return Response.json({historyId:"100"});
  if((path==="/messages/p"||path==="/messages/g")&&u.searchParams.get("format")==="raw")return Response.json(resource(path.at(-1)!));
  if((path==="/messages/p"||path==="/messages/g")&&u.searchParams.get("format")==="minimal")return Response.json({id:path.at(-1),labelIds:["INBOX"]});
  throw new Error("Unexpected synthetic route");
};
self.onmessage=async({data})=>{
  if(data==="valid"){files=1;return;}
  if(data==="stop"){await backend.stop();self.postMessage("stopped");self.close();return;}
  const port=data as MessagePort, platform={uuid:()=>crypto.randomUUID(),yield:()=>new Promise<void>(r=>setTimeout(r,0))};
  const store=await IdbMailStore.open({name:"capture-ui-synthetic",factory:self.indexedDB,platform,instantSearch:false});
  const providers:ProviderRegistry={create:(ctx)=>createGmailApiProvider(ctx,{tokens:{get:async()=>"synthetic",invalidate(){}},buildRaw:async()=>new Uint8Array()}),async verifyImap(){},async connectGmail(){throw new Error("No external consent");}};
  backend=new BackendCore({store,platform,providers,cipher:plaintextCipher,version:"test",autoSync:false,iconTransport:null,incomingProcessor:createBrowserIncomingProcessor()});
  await backend.ready;
  if(!(await store.accounts.list()).length)await store.accounts.create({kind:"gmail",email:"me@example.test",displayName:"Synthetic",color:"blue",now:1});
  await backend.syncAccount(1);
  if((await store.accounts.get(1))?.syncState.status!=="idle")throw new Error("Synthetic sync was not healthy");
  const listeners=new Set<(m:RpcMessage)=>void>();port.onmessage=({data})=>{if(isRpcMessage(data))for(const listener of listeners)listener(data);};port.start();
  backend.connect({send:(m)=>port.postMessage(m),onMessage:(listener)=>{listeners.add(listener);return()=>listeners.delete(listener);},onClose:()=>()=>{},close:()=>port.close()},{clientId:"capture-ui",origin:"renderer"});
  self.postMessage("ready");
};
