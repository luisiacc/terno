import "fake-indexeddb/auto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "./store";
import { IDBFactory } from "fake-indexeddb";
import { openDatabase, openDatabaseWith, SqlMailStore } from "../../db/src/index";
import { captureRowBytes, type MailStore, type CaptureRepairRow } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();vi.restoreAllMocks();});
async function fixture(kind: "SQL" | "IDB" | "WASM") {
  const dir=mkdtempSync(join(tmpdir(),"terno-capture-store-")), path=join(dir,"synthetic.db"), name=crypto.randomUUID(), factory=new IDBFactory();
  const platform={uuid:()=>crypto.randomUUID(),yield:()=>new Promise<void>(r=>setImmediate(r))};
  let driver: import("../../db/src/connection").SqliteDriver | undefined;
  if(kind === "WASM") {
    const {captureRepairWasm}=await import("../../db/src/test/capture-repair-wasm");
    driver=await captureRepairWasm({read:(p)=>existsSync(p)?new Uint8Array(readFileSync(p)):null,write:(p,b)=>writeFileSync(p,b)});
  }
  const open=async():Promise<MailStore>=>kind === "IDB" ? IdbMailStore.open({name,factory,platform,instantSearch:false}) : new SqlMailStore(driver ? openDatabaseWith(driver,path) : openDatabase(path),{platform,instantSearch:false});
  let store=await open();
  cleanup.push(async()=>{await store.close();rmSync(dir,{recursive:true,force:true});});
  const {account}=await store.accounts.create({kind:"gmail",email:"synthetic@example.test",displayName:"Synthetic",color:"blue",now:1});
  return {account,get store(){return store;}, async reopen(){await store.close();store=await open();}};
}
const locator=(id:string)=>({kind:"gmail" as const,providerId:id});

describe.each(["SQL","IDB","WASM"] as const)("%s capture obligation",kind=>{
  it("deduplicates bounded pages, fences retry revisions, rolls back publication and survives reopen",async()=>{
    const t=await fixture(kind), a=t.account.id;
    for(let i=0;i<51;i++)await t.store.captureRepairs.block(a,locator(`p${String(i).padStart(3,"0")}`),"mime-parts",0);
    const first=await t.store.captureRepairs.list(a);expect(first.items).toHaveLength(50);expect(first.next).toBe(first.items.at(-1)!.key);
    expect((await t.store.captureRepairs.list(a,first.next)).items).toHaveLength(1);
    const row=first.items[0]!;
    await t.store.captureRepairs.block(a,row.locator,"mime-parts",0);
    let checks=0;await expect(t.store.captureRepairs.block(a,locator("rollback"),"mime-parts",0,()=>{if(++checks===2)throw new Error("Synthetic transaction interruption");})).rejects.toThrow();
    expect(await t.store.captureRepairs.get(a,locator("rollback"))).toBeNull();
    await t.reopen();expect(await t.store.captureRepairs.list(a)).toEqual(first);
    await t.store.captureRepairs.retry(a,row.key,row.revision);
    const retried=await t.store.captureRepairs.get(a,row.locator);expect(retried).toMatchObject({state:"pending",revision:1});
    await expect(t.store.captureRepairs.block(a,row.locator,"mime-parts",0)).rejects.toThrow("repair changed");
    await t.store.captureRepairs.block(a,row.locator,"mime-parts",1);
    await t.store.captureRepairs.retire(a,row.locator);expect(await t.store.captureRepairs.get(a,row.locator)).toBeNull();
    await t.store.accounts.remove(a);expect((await t.store.captureRepairs.list(a)).items).toEqual([]);
    const replacement=await t.store.accounts.create({kind:"gmail",email:"synthetic@example.test",displayName:"Replacement",color:"blue",now:1});
    expect(replacement.account.id).toBeGreaterThan(a);await expect(t.store.captureRepairs.block(a,locator("old"),"mime-parts",0)).rejects.toThrow();
  });
  it("excludes more than 50 blocked cached items before selection, preserves other accounts and releases on message deletion",async()=>{
    const t=await fixture(kind),a=t.account.id;
    const incoming=Array.from({length:52},(_,i)=>({accountId:a,providerMsgId:`cached${i}`,providerThreadId:null,rfcMessageId:`cached${i}@example.test`,inReplyTo:null,references:[],from:{name:"",email:"sender@example.test"},to:[],cc:[],bcc:[],subject:`Cached ${i}`,date:1,snippet:"",bodyText:"Cached text",bodyHtml:null,bodyState:"full" as const,listId:null,isRead:true,isStarred:false,inInbox:true,isSent:false,isDraft:false,isTrash:false,isSpam:false,hasAttachments:true,size:5}));
    await t.store.sync.ingest(incoming,{applyFilters:false,now:1,classifier:null});
    for(let i=0;i<51;i++)await t.store.captureRepairs.block(a,locator(`cached${i}`),"mime-parts",0);
    const provider=t.store.providerStore(a), good=await provider.messageByProviderId("cached51");
    expect(await provider.pendingAttachmentBodies(50)).toEqual([{id:good!.id,providerMsgId:"cached51"}]);
    const other=await t.store.accounts.create({kind:"gmail",email:"other@example.test",displayName:"Other",color:"blue",now:1});
    await t.store.captureRepairs.block(other.account.id,locator("other"),"mime-parts",0);
    const target=(await provider.messageByProviderId("cached0"))!.id;
    await t.store.sync.remove([target]);expect(await t.store.captureRepairs.get(a,locator("cached0"))).toBeNull();
    expect((await t.store.captureRepairs.list(other.account.id)).items).toHaveLength(1);
    await t.reopen();expect(await t.store.providerStore(a).pendingAttachmentBodies(50)).toEqual([{id:good!.id,providerMsgId:"cached51"}]);
  });
  it("retires an obsolete IMAP locator and refuses its late repair completion without touching the new generation",async()=>{
    const t=await fixture(kind);
    const {account}=await t.store.accounts.create({kind:"imap",email:"imap@example.test",displayName:"IMAP",color:"blue",now:1});
    const a=account.id;
    await t.store.sync.ingest([{accountId:a,providerMsgId:"imap-source",providerThreadId:null,rfcMessageId:"imap-source@example.test",inReplyTo:null,references:[],from:{name:"",email:"sender@example.test"},to:[],cc:[],bcc:[],subject:"IMAP source",date:1,snippet:"",bodyText:null,bodyHtml:null,bodyState:"none",listId:null,isRead:true,isStarred:false,inInbox:true,isSent:false,isDraft:false,isTrash:false,isSpam:false,hasAttachments:false,size:5,locations:[{mailbox:"Projects",uidvalidity:10,uid:2,flags:[]}]}],{applyFilters:false,now:1,classifier:null});
    const provider=t.store.providerStore(a), id=(await provider.messageByProviderId("imap-source"))!.id;
    const old={kind:"imap" as const,messageId:id,mailbox:"Projects",uidvalidity:10,uid:2};
    await t.store.captureRepairs.block(a,old,"mime-depth",0);expect(await provider.pendingBodies(50)).toEqual([]);expect(await provider.countPendingBodies()).toBe(0);
    const repair=(await t.store.captureRepairs.get(a,old))!;await t.store.captureRepairs.retry(a,repair.key,0);
    await provider.locations.upsert(id,"Projects",11,2,[]);
    expect(await t.store.captureRepairs.get(a,old)).toBeNull();
    await expect(t.store.sync.setBody(id,"Stale body",null,{now:1,classifier:null,repair:{key:repair.key,revision:1}})).rejects.toThrow("repair changed");
    expect(await provider.pendingBodies(50)).toEqual([{id,mailbox:"Projects",uidvalidity:11,uid:2}]);
    const row=(await t.store.debug.snapshot()).messages.find(m=>m.id===id)!;expect(row.bodyText).toBeNull();
    await expect(t.store.captureRepairs.block(a,old,"mime-depth",1)).rejects.toThrow("repair changed");
    await t.reopen();expect(await t.store.providerStore(a).pendingBodies(50)).toEqual([{id,mailbox:"Projects",uidvalidity:11,uid:2}]);
  });
  it("backpressures at exactly 1000 identities, deduplicates at capacity, and releases capacity on deletion",async()=>{
    const t=await fixture(kind),a=t.account.id;
    for(let i=0;i<1000;i++)await t.store.captureRepairs.block(a,locator(`p${i}`),"mime-parts",0);
    await t.store.captureRepairs.block(a,locator("p0"),"mime-parts",0);
    await expect(t.store.captureRepairs.block(a,locator("overflow"),"mime-parts",0)).rejects.toThrow("capacity");
    await t.reopen();expect(await t.store.captureRepairs.get(a,locator("overflow"))).toBeNull();
    await t.store.captureRepairs.retire(a,locator("p0"));await t.store.captureRepairs.block(a,locator("replacement"),"mime-parts",0);
    expect(await t.store.captureRepairs.get(a,locator("replacement"))).toMatchObject({state:"blocked"});
  });
  it("accounts the full UTF8 persisted metadata envelope at the byte boundary and rolls back an oversized update",async()=>{
    const t=await fixture(kind),a=t.account.id;
    const row=(providerId:string):CaptureRepairRow=>({account_id:a,key:JSON.stringify(["gmail",providerId]),message_id:null,locator:JSON.stringify(locator(providerId)),reason:"mime-parts",state:"blocked",revision:0,bytes:0});
    // Independent literal UTF8 envelope: the provider identity occurs in both key and locator.
    // Near the cap the byte counter has seven decimal digits; each é costs four bytes across both fields.
    const overhead=new TextEncoder().encode(JSON.stringify({...row(""),bytes:1048576})).length;
    const length=Math.floor((1048576-overhead)/4), id="é".repeat(length);
    expect(captureRowBytes(row(id))).toBe(overhead+4*length);
    expect(overhead+4*length).toBeLessThanOrEqual(1048576);
    expect(overhead+4*(length+1)).toBeGreaterThan(1048576);
    await t.store.captureRepairs.block(a,locator(id),"mime-parts",0);
    await expect(t.store.captureRepairs.block(a,locator("extra"),"mime-parts",0)).rejects.toThrow("capacity");
    await t.reopen();expect(await t.store.captureRepairs.get(a,locator(id))).toMatchObject({state:"blocked"});
    await t.store.captureRepairs.retire(a,locator(id));
    await expect(t.store.captureRepairs.block(a,locator(id+"é"),"mime-parts",0)).rejects.toThrow("capacity");
    expect((await t.store.captureRepairs.list(a)).items).toEqual([]);
  });
});
