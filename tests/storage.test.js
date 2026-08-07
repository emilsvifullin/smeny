import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKUP_KEY,
  DB_KEY,
  StorageConflictError,
  StorageCorruptError,
  createAppStorage
} from "../src/storage.js";
import {normalizeDraftForSave} from "../src/domain.js";
import {POINTS} from "../src/config.js";

class FakeStorage{
  constructor(){this.map=new Map();}
  getItem(key){return this.map.has(key)?this.map.get(key):null;}
  setItem(key,value){this.map.set(key,String(value));}
  removeItem(key){this.map.delete(key);}
}

const makeShift=(id="s-storage-test01")=>normalizeDraftForSave({
  id,
  date:"2026-08-07",
  point:POINTS[0],
  type:"main",
  shk:"",
  partial:false,
  hours:"",
  bonus:"",
  fine:""
});

test("save performs revision check and read-back",async()=>{
  const persistentStorage=new FakeStorage();
  const store=createAppStorage({persistentStorage,lockManager:null,now:()=>"2026-08-07T10:00:00.000Z"});
  const loaded=await store.load();
  const saved=await store.save([makeShift()],{expectedRevision:loaded.revision});
  assert.ok(saved.revision);
  const reloaded=await store.load();
  assert.equal(reloaded.shifts.length,1);
  assert.equal(reloaded.revision,saved.revision);
});

test("stale revision is rejected",async()=>{
  const persistentStorage=new FakeStorage();
  const store=createAppStorage({persistentStorage,lockManager:null});
  const initial=await store.load();
  await store.save([makeShift()],{expectedRevision:initial.revision});
  await assert.rejects(
    ()=>store.save([],{expectedRevision:initial.revision}),
    StorageConflictError
  );
});

test("previous good version is retained before destructive write",async()=>{
  const persistentStorage=new FakeStorage();
  const store=createAppStorage({persistentStorage,lockManager:null});
  const initial=await store.load();
  const first=await store.save([makeShift()],{expectedRevision:initial.revision});
  await store.save([],{expectedRevision:first.revision});
  assert.ok(persistentStorage.getItem(BACKUP_KEY));
  const restored=await store.restoreBackup();
  assert.equal(restored.shifts.length,1);
});

test("corrupt database fails closed and is not converted to empty",async()=>{
  const persistentStorage=new FakeStorage();
  persistentStorage.setItem(DB_KEY,"{broken json");
  const store=createAppStorage({persistentStorage,lockManager:null});
  await assert.rejects(()=>store.load(),StorageCorruptError);
  assert.equal(persistentStorage.getItem(DB_KEY),"{broken json");
});
