import { blockCapture, captureKey, captureRepair, retryCapture, type CaptureRepairs, type CaptureRepairRow, type CaptureRepairStorage } from "@terno/store";
import type { MemDb } from "./mem";
import { T, type Ctx } from "./mail";
const usage = new WeakMap<MemDb, Map<number, { count: number; bytes: number }>>();
export function installCaptureAccounting(db: MemDb): void {
  const accounts = new Map<number, { count: number; bytes: number }>(); usage.set(db,accounts);
  db.onRow((table,row,prev) => {
    if (table !== "capture_repairs") return;
    for (const [r,sign] of [[prev,-1],[row,1]] as const) {
      if (!r) continue;
      const a=Number(r.account_id), before=accounts.get(a) ?? {count:0,bytes:0};
      const next={count:before.count+sign,bytes:before.bytes+sign*Number(r.bytes)};
      if (next.count) accounts.set(a,next); else accounts.delete(a);
    }
  });
}
export function idbCaptureStorage(c: Ctx): CaptureRepairStorage {
  const rows = c.db.table<CaptureRepairRow>("capture_repairs");
  return {
    get:(a,key)=>rows.get(a,key),
    usage:(a)=>usage.get(c.db)!.get(a) ?? {count:0,bytes:0},
    messageId:(a,l)=>l.kind === "imap" ? l.messageId : T(c,"messages").by("provider",a,l.providerId)[0]?.id ?? null,
    valid:(a,l)=> {
      if(l.kind === "gmail") return T(c,"accounts").get(a)?.kind === "gmail";
      const location=T(c,"message_locations").get(l.messageId,l.mailbox);
      return T(c,"messages").get(l.messageId)?.account_id===a && !T(c,"imap_identity_holds").has(l.messageId) && location?.uid===l.uid && location.uidvalidity===l.uidvalidity;
    },
    put:(r)=>{rows.put(r);}, remove:(a,key)=>{rows.delete(a,key);},
    page:(a,after,state)=>rows.by("fk_account_id",a).filter(r=>r.key>after && (!state || r.state===state)).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).slice(0,50),
  };
}
export function idbCaptureRepairs(c: Ctx, command: <V>(fn:()=>V)=>Promise<V>, read: <V>(fn:()=>V)=>Promise<V>, page?: CaptureRepairs["list"]): CaptureRepairs {
  const db=idbCaptureStorage(c);
  return {
    get:(a,l)=>read(()=>{const r=db.get(a,captureKey(l));return r?captureRepair(r):null;}),
    list: page ?? ((a,after="",state)=>read(()=>{const rows=db.page(a,after,state);return {items:rows.map(captureRepair),...(rows.length===50 && {next:rows.at(-1)!.key})};})),
    block:(a,l,r,v,check)=>command(()=>{check?.();blockCapture(db,a,l,r,v);check?.();}),
    retry:(a,key,v,check)=>command(()=>{check?.();retryCapture(db,a,key,v);check?.();}),
    retire:(a,l,check)=>command(()=>{check?.();db.remove(a,captureKey(l));}),
  };
}
export function retireLocationCapture(c: Ctx,message: number,mailbox: string): void {
  const rows=c.db.table<CaptureRepairRow>("capture_repairs");
  for(const row of rows.by("fk_message_id",message)) if(JSON.parse(row.locator).mailbox===mailbox) rows.deleteRow(row);
}

export function idbCapturePage(db: IDBDatabase, account: number, after = "", state?: "pending"): Promise<import("@terno/core").CaptureRepairPage> {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("capture_repairs","readonly"), items: import("@terno/core").CaptureRepair[]=[];
    const prefix=state ? [account,state] : [account];
    const request=tx.objectStore("capture_repairs").index(state ? "state" : "discovery").openCursor(IDBKeyRange.bound([...prefix,after],[...prefix,[]],true,true));
    request.onsuccess=()=>{const cursor=request.result;if(!cursor || items.length===50)return;items.push(captureRepair(cursor.value));if(items.length<50)cursor.continue();};
    tx.oncomplete=()=>resolve({items,...(items.length===50 && {next:items.at(-1)!.key})});
    tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error ?? new Error("Capture discovery interrupted"));
  });
}
