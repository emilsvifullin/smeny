import test from "node:test";
import assert from "node:assert/strict";

import {
  ADVANCE_POINT_IDS,
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

function shift(
  overrides={},
  recordedOn="2026-08-08"
){
  return normalizeDraftForSave(
    {
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
    },
    null,
    {recordedOn}
  );
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

  assert.deepEqual(
    POINTS,
    expected
  );

  assert.equal(
    new Set(POINTS).size,
    14
  );

  assert.equal(
    new Set(
      POINT_DEFINITIONS.map(
        item=>item.id
      )
    ).size,
    14
  );
});

test("advance payout group contains exactly the six configured PVZ",()=>{
  const names=
    POINT_DEFINITIONS
      .filter(
        item=>
          ADVANCE_POINT_IDS.has(
            item.id
          )
      )
      .map(
        item=>item.name
      );

  assert.deepEqual(
    names,
    [
      "Волгоградский Проспект 73с1",
      "Ярцевская 6",
      "Ярцевская 25а",
      "Пятницкий Переулок 2",
      "Большой Овчинниковский Переулок 16",
      "Прокатная 2"
    ]
  );
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
  const item=
    shift({shk:""});

  assert.equal(
    item.shk,
    ""
  );

  assert.equal(
    calc(item).rate,
    3000
  );
});

test("fixed PVZ use fixed rate regardless of SHK",()=>{
  const item=
    shift({
      point:"6-Я Радиальная 3к11",
      shk:999999
    });

  assert.equal(
    calc(item).fixed,
    true
  );

  assert.equal(
    calc(item).rate,
    3000
  );
});

test("advance PVZ cap the first-half payment and move bonuses to final settlement",()=>{
  const items=
    Array.from(
      {length:4},
      (_,index)=>
        shift(
          {
            id:`s-special-${index}000000`,
            date:`2026-08-${String(index+1).padStart(2,"0")}`,
            point:"Ярцевская 25а",
            shk:650,
            bonus:index===0 ? 1000 : "",
            fine:index===0 ? 500 : ""
          },
          "2026-08-08"
        )
    );

  const result=
    payouts(
      "2026-08",
      items,
      {
        today:"2026-09-10"
      }
    );

  assert.equal(
    result.specialAdvance,
    20000
  );

  assert.equal(
    result.specialCarry,
    6000
  );

  assert.equal(
    result.payment25,
    20000
  );

  assert.equal(
    result.fine10,
    500
  );

  assert.equal(
    result.payment10,
    6500
  );
});

test("regular PVZ pay first-half bonuses and registry fines on the 25th",()=>{
  const item=
    shift(
      {
        date:"2026-08-01",
        shk:650,
        bonus:1000,
        fine:500
      },
      "2026-08-08"
    );

  const result=
    payouts(
      "2026-08",
      [item],
      {
        today:"2026-08-25"
      }
    );

  assert.equal(
    result.gross25,
    7500
  );

  assert.equal(
    result.fine25,
    500
  );

  assert.equal(
    result.payment25,
    7000
  );
});

test("advance PVZ historical fines stay in the final settlement for the shift month",()=>{
  const item=
    shift(
      {
        date:"2026-07-17",
        point:"Волгоградский Проспект 73с1",
        shk:650,
        fine:943.35
      },
      "2026-08-11"
    );

  const result=
    payouts(
      "2026-07",
      [item],
      {
        today:"2026-08-25"
      }
    );

  assert.equal(
    result.fine25,
    0
  );

  assert.equal(
    result.fine10,
    943.35
  );

  assert.deepEqual(
    result.otherFinePayments,
    []
  );
});

test("regular first-half historical fine stays in the 25th payment",()=>{
  const item=
    shift(
      {
        date:"2026-07-01",
        shk:650,
        fine:500
      },
      "2026-08-11"
    );

  const result=
    payouts(
      "2026-07",
      [item],
      {
        today:"2026-08-25"
      }
    );

  assert.equal(
    result.fine25,
    500
  );

  assert.equal(
    result.payment25,
    6000
  );

  assert.equal(
    result.fine10,
    0
  );

  assert.deepEqual(
    result.otherFinePayments,
    []
  );
});

test("regular second-half historical fine stays in the next 10th payment",()=>{
  const item=
    shift(
      {
        date:"2026-07-20",
        shk:650,
        fine:500
      },
      "2026-08-11"
    );

  const result=
    payouts(
      "2026-07",
      [item],
      {
        today:"2026-08-25"
      }
    );

  assert.equal(
    result.fine25,
    0
  );

  assert.equal(
    result.fine10,
    500
  );

  assert.equal(
    result.payment10,
    6000
  );

  assert.deepEqual(
    result.otherFinePayments,
    []
  );
});

test("editing a historical fine recalculates its original settlement without a future correction",()=>{
  const original=
    shift(
      {
        date:"2026-07-20",
        shk:650,
        fine:1000
      },
      "2026-08-02"
    );

  const updated=
    normalizeDraftForSave(
      {
        ...original,
        fine:1500
      },
      original,
      {
        recordedOn:"2026-08-11"
      }
    );

  assert.deepEqual(
    updated.fineEntries,
    [
      {
        amount:1500,
        recordedOn:"2026-07-18"
      }
    ]
  );

  const result=
    payouts(
      "2026-07",
      [updated],
      {
        today:"2026-08-25"
      }
    );

  assert.equal(
    result.fine10,
    1500
  );

  assert.equal(
    result.payment10,
    5000
  );

  assert.deepEqual(
    result.otherFinePayments,
    []
  );
});

test("pricing snapshot keeps historical calculation stable",()=>{
  const item=shift({shk:650});
  const original=calc(item);
  const edited={...item,shk:1};

  assert.equal(
    calc(edited).rate,
    original.rate
  );

  assert.equal(
    calc(edited).base,
    original.base
  );
});

test("changing a pricing driver creates a new pricing snapshot on save",()=>{
  const existing=
    shift({shk:650});

  const updated=
    normalizeDraftForSave(
      {
        ...existing,
        shk:1
      },
      existing
    );

  assert.equal(
    calc(existing).rate,
    6500
  );

  assert.equal(
    calc(updated).rate,
    3000
  );
});

test("partial shifts use a 13-hour workday with half-hour steps",()=>{
  const halfHour=
    shift({
      partial:true,
      hours:0.5,
      shk:350
    });

  assert.equal(
    halfHour.pricing.fullHours,
    13
  );

  assert.equal(
    calc(halfHour).base,
    135
  );

  const halfDay=
    shift({
      partial:true,
      hours:6.5,
      shk:350
    });

  assert.equal(
    calc(halfDay).base,
    1750
  );

  const maxPartial=
    shift({
      partial:true,
      hours:12.5,
      shk:350
    });

  assert.equal(
    maxPartial.hours,
    12.5
  );

  assert.throws(
    ()=>
      shift({
        partial:true,
        hours:13
      }),
    DataValidationError
  );

  assert.throws(
    ()=>
      shift({
        partial:true,
        hours:6.25
      }),
    DataValidationError
  );
});

test("future shifts enter projected payouts but remain marked as planned",()=>{
  const past=
    shift({
      id:"s-test-past0001",
      date:"2026-08-07",
      shk:350
    });

  const future=
    shift({
      id:"s-test-future01",
      date:"2026-08-25",
      shk:650,
      bonus:1000,
      fine:500
    });

  const result=
    payouts(
      "2026-08",
      [past,future],
      {
        today:"2026-08-07"
      }
    );

  assert.equal(
    result.earnedCount,
    1
  );

  assert.equal(
    result.futureCount,
    1
  );

  assert.equal(
    result.enteredCount,
    2
  );

  assert.equal(
    result.gross25,
    calc(past).base
  );

  assert.equal(
    result.gross10,
    calc(future).base+1000
  );

  assert.equal(
    result.fine10,
    500
  );

  assert.equal(
    result.payment10,
    calc(future).base+500
  );
});

test("duplicate ids and unknown points are rejected",()=>{
  const one=shift();

  assert.throws(
    ()=>
      normalizeShiftArray(
        [one,one]
      ),
    DataValidationError
  );

  assert.throws(
    ()=>
      normalizeShiftArray([
        {
          ...one,
          pointId:undefined,
          point:"Несуществующий ПВЗ"
        }
      ]),
    DataValidationError
  );
});

test("backup envelope round-trips fine history",()=>{
  const original=[
    shift(
      {
        shk:450,
        bonus:100,
        fine:50
      },
      "2026-08-08"
    )
  ];

  const envelope=
    createBackupEnvelope(
      original,
      {
        revision:"rev-1",
        exportedAt:
          "2026-08-07T10:00:00.000Z"
      }
    );

  const parsed=
    parseBackupJson(
      JSON.stringify(envelope)
    );

  assert.equal(
    parsed.revision,
    "rev-1"
  );

  assert.deepEqual(
    parsed.shifts,
    original
  );
});

test("newer backup schema is rejected instead of guessed",()=>{
  const envelope=
    createBackupEnvelope(
      [shift()],
      {revision:"rev"}
    );

  envelope.schemaVersion=999;

  assert.throws(
    ()=>
      parseBackupJson(
        JSON.stringify(envelope)
      ),
    DataValidationError
  );
});
