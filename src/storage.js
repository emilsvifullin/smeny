import {
  createBackupEnvelope,
  parseBackupJson
} from "./domain.js";

export const DB_KEY="shift-register-db-v3";
export const LEGACY_DB_KEY="wb-shifts-v1";
export const BACKUP_KEY="shift-register-last-good-v3";
export const CORRUPT_KEY="shift-register-corrupt-v3";
export const CHANNEL_NAME="shift-register-sync-v3";

export class StorageConflictError extends Error {
  constructor(message="Данные изменились в другой вкладке"){
    super(message);
    this.name="StorageConflictError";
    this.code="storage_conflict";
  }
}

export class StorageUnavailableError extends Error {
  constructor(message="Постоянное хранилище недоступно"){
    super(message);
    this.name="StorageUnavailableError";
    this.code="storage_unavailable";
  }
}

export class StorageCorruptError extends Error {
  constructor(message,cause=null,raw=null){
    super(message);
    this.name="StorageCorruptError";
    this.code="storage_corrupt";
    this.cause=cause;
    this.raw=raw;
  }
}

function createRevision(){
  if(globalThis.crypto?.randomUUID){
    return globalThis.crypto.randomUUID();
  }
  if(globalThis.crypto?.getRandomValues){
    const bytes=new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  }
  throw new StorageUnavailableError("Безопасный генератор ревизий недоступен");
}

function probeLocalStorage(candidate){
  if(!candidate) return false;
  try{
    const key=`__shift_register_probe_${Date.now()}`;
    candidate.setItem(key,"1");
    candidate.removeItem(key);
    return true;
  }catch{
    return false;
  }
}

class MemoryStorage {
  constructor(){ this.map=new Map(); }
  getItem(key){ return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key,value){ this.map.set(key,String(value)); }
  removeItem(key){ this.map.delete(key); }
}

function parseStoredRaw(raw){
  try{
    return parseBackupJson(raw);
  }catch(error){
    throw new StorageCorruptError("Не удалось прочитать сохранённые данные. Исходная копия не изменена.",error,raw);
  }
}

export function createAppStorage({
  persistentStorage=globalThis.localStorage,
  lockManager=globalThis.navigator?.locks,
  now=()=>new Date().toISOString()
}={}){
  const persistent=probeLocalStorage(persistentStorage);
  const storage=persistent ? persistentStorage : new MemoryStorage();
  const mode=persistent ? "local" : "memory";

  const withWriteLock=async fn=>{
    if(lockManager?.request){
      return lockManager.request("shift-register-database",{mode:"exclusive"},fn);
    }
    return fn();
  };

  const currentRaw=()=>storage.getItem(DB_KEY) ?? storage.getItem(LEGACY_DB_KEY);

  const parseCurrent=()=>{
    const dbRaw=storage.getItem(DB_KEY);
    if(dbRaw!==null){
      const parsed=parseStoredRaw(dbRaw);
      return {raw:dbRaw,key:DB_KEY,...parsed};
    }

    const legacyRaw=storage.getItem(LEGACY_DB_KEY);
    if(legacyRaw!==null){
      const parsed=parseStoredRaw(legacyRaw);
      return {raw:legacyRaw,key:LEGACY_DB_KEY,...parsed};
    }

    return {raw:null,key:null,revision:null,shifts:[],source:"empty"};
  };

  async function load(){
    let parsed=parseCurrent();

    // Валидная старая база мигрируется сразу и атомарно в v3, чтобы тарифный
    // снимок зафиксировался в момент обновления приложения, а не когда-нибудь позже.
    if(parsed.raw!==null && (parsed.key===LEGACY_DB_KEY || parsed.source==="legacy-array")){
      parsed=await withWriteLock(async()=>{
        const latest=parseCurrent();
        if(latest.raw===null || (latest.key===DB_KEY && latest.source==="envelope")) return latest;

        const revision=createRevision();
        const envelope=createBackupEnvelope(latest.shifts,{
          revision,
          exportedAt:now()
        });
        const raw=JSON.stringify(envelope);
        storage.setItem(BACKUP_KEY,latest.raw);
        storage.setItem(DB_KEY,raw);
        const verified=parseStoredRaw(storage.getItem(DB_KEY));
        if(verified.revision!==revision){
          throw new StorageUnavailableError("Не удалось проверить миграцию данных");
        }
        return {raw,key:DB_KEY,...verified};
      });
    }

    return {
      mode,
      persistent,
      revision:parsed.revision ?? null,
      shifts:parsed.shifts,
      source:parsed.source,
      sourceKey:parsed.key,
      hasBackup:storage.getItem(BACKUP_KEY)!==null
    };
  }

  async function save(shifts,{expectedRevision=null}={}){
    return withWriteLock(async()=>{
      const before=parseCurrent();
      const actualRevision=before.revision ?? null;

      if(actualRevision!==expectedRevision){
        throw new StorageConflictError();
      }

      const revision=createRevision();
      const envelope=createBackupEnvelope(shifts,{
        revision,
        exportedAt:now()
      });
      const raw=JSON.stringify(envelope);

      if(before.raw!==null){
        storage.setItem(BACKUP_KEY,before.raw);
      }

      storage.setItem(DB_KEY,raw);

      // Read-back verification catches quota/storage implementations that fail silently.
      const verifiedRaw=storage.getItem(DB_KEY);
      if(verifiedRaw!==raw){
        throw new StorageUnavailableError("Проверка записи не прошла");
      }

      const verified=parseStoredRaw(verifiedRaw);
      if(verified.revision!==revision){
        throw new StorageUnavailableError("Ревизия после записи не совпала");
      }

      return {
        revision,
        shifts:verified.shifts,
        mode,
        persistent,
        hasBackup:storage.getItem(BACKUP_KEY)!==null
      };
    });
  }

  async function restoreBackup(){
    return withWriteLock(async()=>{
      const backupRaw=storage.getItem(BACKUP_KEY);
      if(backupRaw===null){
        throw new StorageUnavailableError("Резервная копия для восстановления отсутствует");
      }

      const backup=parseStoredRaw(backupRaw);
      const damaged=currentRaw();
      if(damaged!==null){
        storage.setItem(CORRUPT_KEY,damaged);
      }

      const revision=createRevision();
      const envelope=createBackupEnvelope(backup.shifts,{
        revision,
        exportedAt:now()
      });
      const raw=JSON.stringify(envelope);
      storage.setItem(DB_KEY,raw);

      const verified=parseStoredRaw(storage.getItem(DB_KEY));
      if(verified.revision!==revision){
        throw new StorageUnavailableError("Не удалось проверить восстановленную копию");
      }

      return {
        revision,
        shifts:verified.shifts,
        mode,
        persistent,
        hasBackup:true
      };
    });
  }

  async function replaceCorrupt(shifts){
    return withWriteLock(async()=>{
      const damaged=currentRaw();
      if(damaged!==null){
        storage.setItem(CORRUPT_KEY,damaged);
      }

      const revision=createRevision();
      const envelope=createBackupEnvelope(shifts,{
        revision,
        exportedAt:now()
      });
      const raw=JSON.stringify(envelope);
      storage.setItem(DB_KEY,raw);

      const verified=parseStoredRaw(storage.getItem(DB_KEY));
      if(verified.revision!==revision){
        throw new StorageUnavailableError("Не удалось проверить заменённую базу");
      }

      return {
        revision,
        shifts:verified.shifts,
        mode,
        persistent,
        hasBackup:storage.getItem(BACKUP_KEY)!==null
      };
    });
  }

  function getBackupRaw(){
    return storage.getItem(BACKUP_KEY);
  }

  function getCurrentRaw(){
    return currentRaw();
  }

  function getCorruptRaw(){
    return storage.getItem(CORRUPT_KEY);
  }

  return {
    mode,
    persistent,
    load,
    save,
    restoreBackup,
    replaceCorrupt,
    getBackupRaw,
    getCurrentRaw,
    getCorruptRaw
  };
}
