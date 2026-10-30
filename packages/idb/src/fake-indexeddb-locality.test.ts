import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { generateDataset } from '@terno/mock-data';
import { REMOVABLE_BUCKETS, storageCutoff } from '@terno/core';
import { IdbMailStore } from './store';
import { databaseName } from './schema';
it('driver counterexample: deleting a bounded unit must not traverse unrelated cached-provider index records', async () => {
 const now=Date.UTC(2026,9,22);
 const store=await IdbMailStore.open({name:crypto.randomUUID(),factory:indexedDB,instantSearch:false,platform:{uuid:()=>crypto.randomUUID(),yield:async()=>{}}});
 let db:IDBDatabase|undefined;
 try {
 const seeded=await store.dev.seed(generateDataset({threads:5000,accounts:4,seed:69,now,bodyScale:2}),{now});
 for(const id of seeded.accountIds) await store.accounts.setSyncState(id,{lastSyncAt:now});
 const ids=(await store.storage.threads(0,5000)).filter(r=>!r.kept).slice(0,20).map(r=>r.id);
 db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(databaseName(store.name));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const index=db.transaction('messages').objectStore('messages').index('cached_provider');
 const tree=(index as unknown as {_rawIndex:{records:{records:{getAllRecords():IterableIterator<unknown>}}}})._rawIndex.records.records;
 const original=tree.getAllRecords; let inspected=0;
 const spy=vi.spyOn(tree,'getAllRecords').mockImplementation(function*(){for(const row of original.call(tree)){inspected++;yield row;}});
 let removed=0;
 try{removed=(await store.storage.remove({threadIds:ids,buckets:[...REMOVABLE_BUCKETS],cutoff:storageCutoff(now,30),maxMessages:30})).messages;}finally{spy.mockRestore();}

 await store.debug.verify();
 expect(removed).toBe(16);
 expect(inspected).toBeLessThanOrEqual(1000);
 }finally{db?.close();await store.close();}
},60000);
