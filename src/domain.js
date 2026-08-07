import {
  ADVANCE_CAP,
  APP_VERSION,
  FIXED_RATE,
  FULL_HOURS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_RECORDS,
  MAX_MONEY,
  MAX_SHK,
  MAX_YEAR,
  MIN_YEAR,
  POINT_BY_ID,
  POINT_BY_NAME,
  POINT_IDS,
  RULES_VERSION,
  SCHEMA_VERSION,
  TIERS,
  isFixedPoint,
  pointIdForName,
  pointNameForId
} from "./config.js";

export class DataValidationError extends Error {
  constructor(message,{recordIndex=null,code="invalid_data"}={}){
    super(recordIndex===null ? message : `Запись ${recordIndex+1}: ${message}`);
    this.name="DataValidationError";
    this.code=code;
    this.recordIndex=recordIndex;
  }
}

export function isPlainObject(value){
  return Boolean(value) && typeof value==="object" && !Array.isArray(value);
}

export function isValidDateString(value){
  if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year,month,day]=value.split("-").map(Number);
  if(year<MIN_YEAR || year>MAX_YEAR) return false;

  const date=new Date(year,month-1,day,12);
  return date.getFullYear()===year &&
    date.getMonth()===month-1 &&
    date.getDate()===day;
}

export function createShiftId(){
  if(globalThis.crypto?.randomUUID){
    return `s-${globalThis.crypto.randomUUID()}`;
  }

  // Старые браузеры: криптографически случайный fallback без Date.now()+Math.random().
  if(globalThis.crypto?.getRandomValues){
    const bytes=new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return "s-"+Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  }

  throw new Error("Безопасный генератор идентификаторов недоступен");
}

export function rateForShk(shk){
  const value=Number(shk) || 0;
  for(const tier of TIERS){
    if(value<tier.lim) return tier.rate;
  }
  return TIERS.at(-1).rate;
}

export function resolvePointIdentity(record,index=null){
  const recordIndex=index;
  const rawName=typeof record?.point==="string" ? record.point : "";
  const rawId=typeof record?.pointId==="string" ? record.pointId : "";


  if(rawId){
    if(!POINT_IDS.has(rawId)){
      throw new DataValidationError("неизвестный идентификатор ПВЗ",{recordIndex,code:"unknown_point"});
    }

    const canonicalName=pointNameForId(rawId);
    if(rawName && rawName!==canonicalName){
      throw new DataValidationError("название ПВЗ не соответствует его идентификатору",{recordIndex,code:"point_mismatch"});
    }

    return {pointId:rawId,point:canonicalName};
  }

  if(!rawName || !POINT_BY_NAME.has(rawName)){
    throw new DataValidationError("неизвестный ПВЗ",{recordIndex,code:"unknown_point"});
  }

  return {pointId:pointIdForName(rawName),point:rawName};
}

function normalizeWhole(value,index,label,{allowEmpty=true,max=Number.MAX_SAFE_INTEGER}={}){
  if(value==="" || value===null || value===undefined){
    if(allowEmpty) return "";
    throw new DataValidationError(`${label} не заполнено`,{recordIndex:index});
  }

  const number=Number(value);
  if(!Number.isSafeInteger(number) || number<0 || number>max){
    throw new DataValidationError(`${label} должно быть целым числом от 0 до ${max.toLocaleString("ru-RU")}`,{recordIndex:index});
  }

  return number;
}

function normalizeHours(value,index,partial){
  if(!partial) return FULL_HOURS;
  const hours=Number(value);

  if(
    !Number.isFinite(hours) ||
    hours<0.5 ||
    hours>11.5 ||
    !Number.isInteger(hours*2)
  ){
    throw new DataValidationError("часы должны быть от 0,5 до 11,5 с шагом 0,5",{recordIndex:index});
  }

  return hours;
}

export function snapshotPricing({pointId,point,shk}){
  const id=pointId || pointIdForName(point);
  if(!id || !POINT_BY_ID.has(id)){
    throw new DataValidationError("невозможно определить тариф для неизвестного ПВЗ");
  }

  const fixed=isFixedPoint(id);
  const rate=fixed ? FIXED_RATE : rateForShk(shk);

  return Object.freeze({
    version:1,
    rulesVersion:RULES_VERSION,
    fixed,
    rate,
    fullHours:FULL_HOURS
  });
}

function normalizePricing(value,index,shift){
  if(value===undefined || value===null){
    return snapshotPricing(shift);
  }

  if(!isPlainObject(value)){
    throw new DataValidationError("некорректный снимок тарифа",{recordIndex:index});
  }

  const version=Number(value.version);
  const rate=Number(value.rate);
  const fullHours=Number(value.fullHours);
  const fixed=value.fixed;
  const rulesVersion=value.rulesVersion;

  if(
    version!==1 ||
    typeof rulesVersion!=="string" ||
    !rulesVersion ||
    typeof fixed!=="boolean" ||
    !Number.isSafeInteger(rate) ||
    rate<0 ||
    rate>MAX_MONEY ||
    !Number.isFinite(fullHours) ||
    fullHours<=0 ||
    fullHours>24
  ){
    throw new DataValidationError("некорректный снимок тарифа",{recordIndex:index});
  }

  return {version:1,rulesVersion,fixed,rate,fullHours};
}

function migrateLegacy(record,index){
  if(!isPlainObject(record)){
    throw new DataValidationError("ожидался объект смены",{recordIndex:index});
  }

  if(
    Object.prototype.hasOwnProperty.call(record,"v") &&
    ![1,2,3].includes(record.v)
  ){
    throw new DataValidationError("неподдерживаемая версия записи",{recordIndex:index,code:"unsupported_version"});
  }

  const version=record.v ?? 1;
  const share=Number(record.share);
  const hasValidShare=Number.isFinite(share) && share>=0 && share<=100;
  const legacyPartial=hasValidShare && share>0 && share<100;

  const partial=version>=2
    ? record.partial
    : legacyPartial;

  const hours=partial
    ? (version>=2
        ? record.hours
        : Math.round(FULL_HOURS*share/100*10)/10)
    : FULL_HOURS;

  const legacyTrainees=normalizeWhole(record.trainees,index,"Стажёры",{allowEmpty:true,max:1000});
  const legacyBonusBase=normalizeWhole(record.bonus,index,"Премия",{allowEmpty:true,max:MAX_MONEY});
  const legacyBonus=(legacyBonusBase==="" ? 0 : legacyBonusBase) +
    Math.round(
      (legacyTrainees==="" ? 0 : legacyTrainees)*
      1000*
      (hasValidShare ? share : 100)/100
    );

  return {
    ...record,
    v:version,
    partial,
    hours,
    bonus:version>=2 ? record.bonus : legacyBonus
  };
}

export function normalizeShiftRecord(source,index=0){
  const migrated=migrateLegacy(source,index);

  if(
    typeof migrated.id!=="string" ||
    !/^s-[A-Za-z0-9-]{8,100}$/.test(migrated.id)
  ){
    // Старые версии использовали более короткие id вида sxxxx.
    if(
      typeof migrated.id!=="string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(migrated.id)
    ){
      throw new DataValidationError("некорректный идентификатор",{recordIndex:index});
    }
  }

  if(!isValidDateString(migrated.date)){
    throw new DataValidationError(`некорректная дата (допустимы ${MIN_YEAR}–${MAX_YEAR} годы)`,{recordIndex:index});
  }

  const identity=resolvePointIdentity(migrated,index);

  if(!["main","extra"].includes(migrated.type)){
    // v1 мог не иметь type: тогда основная смена.
    if((migrated.v ?? 1)===1 && (migrated.type===undefined || migrated.type===null || migrated.type==="")){
      migrated.type="main";
    }else{
      throw new DataValidationError("некорректный тип смены",{recordIndex:index});
    }
  }

  if(typeof migrated.partial!=="boolean"){
    throw new DataValidationError("некорректный тип отработанного времени",{recordIndex:index});
  }

  const fixed=isFixedPoint(identity.pointId);
  const shk=fixed
    ? 0
    : normalizeWhole(migrated.shk,index,"ШК",{allowEmpty:true,max:MAX_SHK});

  const hours=normalizeHours(migrated.hours,index,migrated.partial);
  const bonus=normalizeWhole(migrated.bonus,index,"Премия",{allowEmpty:true,max:MAX_MONEY});
  const fine=normalizeWhole(migrated.fine,index,"Штраф",{allowEmpty:true,max:MAX_MONEY});

  const baseShift={
    v:SCHEMA_VERSION,
    id:migrated.id,
    date:migrated.date,
    pointId:identity.pointId,
    point:identity.point,
    type:migrated.type,
    shk,
    partial:migrated.partial,
    hours,
    bonus,
    fine
  };

  return {
    ...baseShift,
    pricing:normalizePricing(migrated.pricing,index,baseShift)
  };
}

export function normalizeShiftArray(value){
  if(!Array.isArray(value)){
    throw new DataValidationError("JSON должен содержать массив смен",{code:"not_array"});
  }

  if(value.length>MAX_IMPORT_RECORDS){
    throw new DataValidationError(`слишком много смен: максимум ${MAX_IMPORT_RECORDS}`);
  }

  const ids=new Set();
  const normalized=value.map((record,index)=>{
    const shift=normalizeShiftRecord(record,index);
    if(ids.has(shift.id)){
      throw new DataValidationError("идентификатор повторяется",{recordIndex:index,code:"duplicate_id"});
    }
    ids.add(shift.id);
    return shift;
  });

  return normalized;
}

export function createBackupEnvelope(shifts,{revision=null,exportedAt=new Date().toISOString()}={}){
  const normalized=normalizeShiftArray(shifts);
  return {
    schemaVersion:SCHEMA_VERSION,
    appVersion:APP_VERSION,
    rulesVersion:RULES_VERSION,
    exportedAt,
    revision,
    shifts:normalized
  };
}

export function parseBackupValue(value){
  if(Array.isArray(value)){
    return {
      envelopeVersion:1,
      source:"legacy-array",
      revision:null,
      shifts:normalizeShiftArray(value)
    };
  }

  if(!isPlainObject(value)){
    throw new DataValidationError("резервная копия должна быть массивом или объектом Shift Register");
  }

  if(value.schemaVersion!==SCHEMA_VERSION){
    throw new DataValidationError(
      value.schemaVersion>SCHEMA_VERSION
        ? "резервная копия создана более новой версией приложения"
        : "неподдерживаемая версия резервной копии",
      {code:"unsupported_backup_version"}
    );
  }

  if(typeof value.exportedAt!=="string" || Number.isNaN(Date.parse(value.exportedAt))){
    throw new DataValidationError("некорректная дата создания резервной копии");
  }

  if(value.revision!==null && value.revision!==undefined && typeof value.revision!=="string"){
    throw new DataValidationError("некорректная ревизия резервной копии");
  }

  return {
    envelopeVersion:value.schemaVersion,
    source:"envelope",
    revision:value.revision ?? null,
    shifts:normalizeShiftArray(value.shifts)
  };
}

export function parseBackupJson(text){
  if(typeof text!=="string"){
    throw new DataValidationError("резервная копия должна быть текстом");
  }

  const bytes=new TextEncoder().encode(text).byteLength;
  if(bytes>MAX_IMPORT_BYTES){
    throw new DataValidationError(`резервная копия слишком большая: максимум ${Math.round(MAX_IMPORT_BYTES/1024/1024)} МБ`);
  }

  let parsed;
  try{
    parsed=JSON.parse(text);
  }catch{
    throw new DataValidationError("вставленный текст не является корректным JSON",{code:"invalid_json"});
  }

  return parseBackupValue(parsed);
}

export function pricingDriversEqual(a,b){
  if(!a || !b) return false;
  const aIdentity=resolvePointIdentity(a);
  const bIdentity=resolvePointIdentity(b);
  const aShk=isFixedPoint(aIdentity.pointId) ? 0 : (a.shk==="" ? "" : Number(a.shk));
  const bShk=isFixedPoint(bIdentity.pointId) ? 0 : (b.shk==="" ? "" : Number(b.shk));
  return aIdentity.pointId===bIdentity.pointId && aShk===bShk;
}

export function normalizeDraftForSave(value,existingShift=null){
  if(!isPlainObject(value)){
    throw new DataValidationError("черновик смены повреждён");
  }

  if(!isValidDateString(value.date)){
    throw new DataValidationError("выберите корректную дату",{code:"date"});
  }

  const identity=resolvePointIdentity(value);

  if(!["main","extra"].includes(value.type)){
    throw new DataValidationError("выберите тип смены",{code:"type"});
  }

  if(typeof value.partial!=="boolean"){
    throw new DataValidationError("выберите отработанное время",{code:"partial"});
  }

  const fixed=isFixedPoint(identity.pointId);
  const shk=fixed ? 0 : normalizeWhole(value.shk,null,"ШК",{allowEmpty:true,max:MAX_SHK});
  const hours=normalizeHours(value.hours,null,value.partial);
  const bonus=normalizeWhole(value.bonus,null,"Премия",{allowEmpty:true,max:MAX_MONEY});
  const fine=normalizeWhole(value.fine,null,"Штраф",{allowEmpty:true,max:MAX_MONEY});

  const base={
    v:SCHEMA_VERSION,
    id:value.id,
    date:value.date,
    pointId:identity.pointId,
    point:identity.point,
    type:value.type,
    shk,
    partial:value.partial,
    hours,
    bonus,
    fine
  };

  const pricing=(
    existingShift &&
    existingShift.pricing &&
    pricingDriversEqual(existingShift,base)
  )
    ? normalizePricing(existingShift.pricing,null,existingShift)
    : snapshotPricing(base);

  return {...base,pricing};
}

export function calc(shift){
  const normalized=shift.v===SCHEMA_VERSION && shift.pricing
    ? shift
    : normalizeShiftRecord(shift,0);

  const pricing=normalizePricing(normalized.pricing,null,normalized);
  const hours=normalized.partial ? Number(normalized.hours) : pricing.fullHours;
  const perHour=pricing.rate/pricing.fullHours;
  // Бизнес-правило: неполная смена округляется до целого рубля отдельно по каждой смене.
  const base=normalized.partial ? Math.round(perHour*hours) : pricing.rate;
  const bonus=normalized.bonus==="" ? 0 : Number(normalized.bonus);
  const fine=normalized.fine==="" ? 0 : Number(normalized.fine);

  return {
    fixed:pricing.fixed,
    rate:pricing.rate,
    hours,
    perHour,
    base,
    bonus,
    fine,
    total:base+bonus-fine,
    rulesVersion:pricing.rulesVersion
  };
}

export function inMonth(shifts,ym){
  return shifts
    .filter(shift=>shift.date.slice(0,7)===ym)
    .sort((a,b)=>a.date===b.date ? a.id.localeCompare(b.id) : (a.date<b.date ? 1 : -1));
}

export function sumUp(list){
  const aggregate={n:list.length,shk:0,base:0,bonus:0,fine:0,total:0,extra:0,part:0};
  for(const shift of list){
    const result=calc(shift);
    aggregate.shk+=result.fixed ? 0 : (Number(shift.shk)||0);
    aggregate.base+=result.base;
    aggregate.bonus+=result.bonus;
    aggregate.fine+=result.fine;
    aggregate.total+=result.total;
    if(shift.type==="extra") aggregate.extra++;
    if(shift.partial) aggregate.part++;
  }
  return aggregate;
}

export function payouts(ym,shifts,{today}={}){
  const currentDay=today || new Date().toLocaleDateString("sv-SE");
  if(!isValidDateString(currentDay)){
    throw new DataValidationError("некорректная текущая дата");
  }

  const list=inMonth(shifts,ym);
  const earned=list.filter(shift=>shift.date<=currentDay);
  const futureCount=list.length-earned.length;
  const dayOf=shift=>Number(shift.date.slice(8,10));

  // Бизнес-правило: премии не входят в аванс; штрафы уменьшают начисление.
  const netWithoutBonus=items=>items.reduce((sum,shift)=>{
    const result=calc(shift);
    return sum+result.base-result.fine;
  },0);

  const firstHalf=earned.filter(shift=>dayOf(shift)<=15);
  const secondHalf=earned.filter(shift=>dayOf(shift)>=16);
  const byAdvanceDate=earned.filter(shift=>dayOf(shift)<=25);
  const firstHalfTotal=netWithoutBonus(firstHalf);
  const secondHalfTotal=netWithoutBonus(secondHalf);
  const accruedBy25=netWithoutBonus(byAdvanceDate);
  const advance=Math.min(Math.max(accruedBy25,0),ADVANCE_CAP);
  const carryToFinal=Math.max(accruedBy25-advance,0);
  const all=sumUp(earned);

  return {
    advance,
    accruedBy25,
    carryToFinal,
    firstHalfTotal,
    secondHalfTotal,
    all,
    rest:all.total-advance,
    futureCount,
    earnedCount:earned.length,
    enteredCount:list.length
  };
}
