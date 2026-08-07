import test from "node:test";
import assert from "node:assert/strict";

import {
  POINTS,
  POINT_DEFINITIONS,
  SCHEMA_VERSION
} from "../src/config.js";
import {
  DataValidationError,
  calc,
  createBackupEnvelope,
  normalizeDraftForSave,
  normalizeShiftArray,
  parseBackupJson,
  payouts,
  rateForShk
} from "../src/domain.js";

const point=POINTS[0];

function shift(overrides={}){
  return normalizeDraftForSave({
    v:SCHEMA_VERSION,
    id:"s-test-00000001",
    date:"2026-08-07",
    point,
    type:"main",
    shk:"",
    partial:false,
    hours:"",
    bonus:"",
    fine:"",
    ...overrides
  });
}

test("production list contains exactly the 14 approved PVZ in order",()=>{
  const expected=[
    "Коммунальная Улица 10",
    "6-Я Радиальная 3к11",
    "Новоясеневский Проспект 22к1",
    "Кузьминская 5",
    "Корабельная 1",
    "Нагатинская Набережная 56а",
    "Волгоградский Проспект 73с1",
    "Ярцевская 6",
    "Ярцевская 25а",
    "Пятницкий Переулок 2",
    "Мустая Карима 12",
    "Крузенштерна 9",
    "Большой Овчинниковский Переулок 16",
    "Прокатная 2"
  ];
  assert.deepEqual(POINTS,expected);
  assert.equal(new Set(POINTS).size,14);
  assert.equal(new Set(POINT_DEFINITIONS.map(item=>item.id)).size,14);
});

test("tariff boundaries are exact",()=>{
  assert.equal(rateForShk(0),3000);
  assert.equal(rateForShk(349),3000);
  assert.equal(rateForShk(350),3500);
  assert.equal(rateForShk(449),3500);
  assert.equal(rateForShk(450),4500);
  assert.equal(rateForShk(549),4500);
  assert.equal(rateForShk(550),5500);
  assert.equal(rateForShk(649),5500);
  assert.equal(rateForShk(650),6500);
});

test("empty barcode is valid and uses base tier",()=>{
  const item=shift({shk:""});
  assert.equal(item.shk,"");
  assert.equal(calc(item).rate,3000);
});


test("fixed PVZ use fixed rate regardless of SHK",()=>{
  const item=shift({point:"6-Я Радиальная 3к11",shk:999999});
  assert.equal(calc(item).fixed,true);
  assert.equal(calc(item).rate,3000);
});

test("advance excludes bonuses and applies fines",()=>{
  const item=shift({date:"2026-08-01",shk:650,bonus:10000,fine:500});
  const result=payouts("2026-08",[item],{today:"2026-08-25"});
  assert.equal(result.accruedBy25,6000);
  assert.equal(result.advance,6000);
  assert.equal(result.all.total,16000);
});
test("pricing snapshot keeps historical calculation stable",()=>{
  const item=shift({shk:650});
  const original=calc(item);
  const edited={...item,shk:1};
  assert.equal(calc(edited).rate,original.rate);
  assert.equal(calc(edited).base,original.base);
});

test("changing a pricing driver creates a new pricing snapshot on save",()=>{
  const existing=shift({shk:650});
  const updated=normalizeDraftForSave({...existing,shk:1},existing);
  assert.equal(calc(existing).rate,6500);
  assert.equal(calc(updated).rate,3000);
});

test("partial shifts use half-hour steps and per-shift rounding",()=>{
  const item=shift({partial:true,hours:0.5,shk:350});
  assert.equal(calc(item).base,146);
  assert.throws(
    ()=>shift({partial:true,hours:0.25}),
    DataValidationError
  );
});

test("future shifts do not enter accrued payouts",()=>{
  const past=shift({id:"s-test-past0001",date:"2026-08-07",shk:350});
  const future=shift({id:"s-test-future01",date:"2026-08-25",shk:650});
  const result=payouts("2026-08",[past,future],{today:"2026-08-07"});
  assert.equal(result.earnedCount,1);
  assert.equal(result.futureCount,1);
  assert.equal(result.accruedBy25,calc(past).base);
});

test("advance never exceeds configured cap",()=>{
  const items=Array.from({length:5},(_,index)=>shift({
    id:`s-test-cap-${index}000000`,
    date:`2026-08-${String(index+1).padStart(2,"0")}`,
    shk:650
  }));
  const result=payouts("2026-08",items,{today:"2026-08-25"});
  assert.equal(result.advance,20000);
  assert.equal(result.carryToFinal,12500);
});

test("duplicate ids and unknown points are rejected",()=>{
  const one=shift();
  assert.throws(()=>normalizeShiftArray([one,one]),DataValidationError);
  assert.throws(()=>normalizeShiftArray([{...one,pointId:undefined,point:"Несуществующий ПВЗ"}]),DataValidationError);
});

test("backup envelope round-trips",()=>{
  const original=[shift({shk:450,bonus:100,fine:50})];
  const envelope=createBackupEnvelope(original,{revision:"rev-1",exportedAt:"2026-08-07T10:00:00.000Z"});
  const parsed=parseBackupJson(JSON.stringify(envelope));
  assert.equal(parsed.revision,"rev-1");
  assert.deepEqual(parsed.shifts,original);
});

test("newer backup schema is rejected instead of guessed",()=>{
  const envelope=createBackupEnvelope([shift()],{revision:"rev"});
  envelope.schemaVersion=999;
  assert.throws(()=>parseBackupJson(JSON.stringify(envelope)),DataValidationError);
});
