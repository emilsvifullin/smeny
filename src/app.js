import {
  ADVANCE_CAP,
  APP_VERSION,
  FULL_HOURS,
  MAX_MONEY,
  MAX_SHK,
  MAX_YEAR,
  MIN_YEAR,
  MONTHS,
  MONTHS_G,
  POINTS,
  RULES_VERSION,
  WD,
  isFixedPoint
} from "./config.js";

import {
  DataValidationError,
  calc as domainCalc,
  createBackupEnvelope,
  createShiftId,
  inMonth as domainInMonth,
  isPlainObject,
  isValidDateString,
  normalizeDraftForSave,
  parseBackupJson,
  payouts as domainPayouts,
  pricingDriversEqual,
  snapshotPricing
} from "./domain.js";

import {
  BACKUP_KEY,
  CHANNEL_NAME,
  DB_KEY,
  LEGACY_DB_KEY,
  StorageConflictError,
  StorageCorruptError,
  createAppStorage
} from "./storage.js";

const UI_KEY="shift-register-ui-v3";
const store=createAppStorage();
const syncChannel=("BroadcastChannel" in window)
  ? new BroadcastChannel(CHANNEL_NAME)
  : null;

let shifts=[];
let tab="shifts";
let cursor=ymOf(new Date());
let draft=null;
let storageOk=true;
let storageRevision=null;
let loadError=null;
let hasBackup=false;
let syncConflict=false;
let sheetPreviousFocus=null;
let pointPreviousFocus=null;
let monthPreviousFocus=null;
let datePreviousFocus=null;

function safeSessionGet(key){
  try{return sessionStorage.getItem(key);}catch{return null;}
}

function safeSessionSet(key,value){
  try{sessionStorage.setItem(key,value);return true;}catch{return false;}
}

function safeSessionRemove(key){
  try{sessionStorage.removeItem(key);}catch{}
}

function pageScroller(){
  return (
    document.querySelector(
      "#app .shift-scroll"
    ) ||
    document.getElementById("app")
  );
}

function pageScrollTop(){
  const scroller=
    pageScroller();

  return scroller
    ? scroller.scrollTop
    : 0;
}

function setPageScrollTop(value){
  const scroller=
    pageScroller();

  if(!scroller){
    return;
  }

  scroller.scrollTop=
    Math.max(
      0,
      Number(value) || 0
    );
}

function validMonthCursor(value){
  if(typeof value!=="string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const [year,month]=value.split("-").map(Number);
  return year>=MIN_YEAR && year<=MAX_YEAR && month>=1 && month<=12;
}

function sanitizeUIState(value){
  if(!isPlainObject(value)) return {};
  return {
    tab:["shifts","stats","data"].includes(value.tab) ? value.tab : "shifts",
    cursor:validMonthCursor(value.cursor) ? value.cursor : ymOf(new Date()),
    scrollY:Number.isFinite(Number(value.scrollY)) ? Math.max(0,Number(value.scrollY)) : 0,
    sheetOpen:value.sheetOpen===true,
    sheetScrollTop:Number.isFinite(Number(value.sheetScrollTop)) ? Math.max(0,Number(value.sheetScrollTop)) : 0,
    draft:isPlainObject(value.draft) ? value.draft : null
  };
}

function saveUIState(){
  try{
    if(
      draft &&
      document.body.classList.contains("sheet-open") &&
      typeof readForm==="function"
    ){
      readForm();
    }

    const sheet=document.getElementById("sheet");
    const sheetOpen=Boolean(
      draft &&
      document.body.classList.contains("sheet-open")
    );

    safeSessionSet(UI_KEY,JSON.stringify({
      tab,
      cursor,
      scrollY:pageScrollTop(),
      sheetOpen,
      sheetScrollTop:sheetOpen && sheet ? sheet.scrollTop : 0,
      draft:sheetOpen ? draft : null
    }));
  }catch{}
}

function loadUIState(){
  const raw=safeSessionGet(UI_KEY);
  if(!raw) return {};
  try{return sanitizeUIState(JSON.parse(raw));}catch{return {};}
}

const savedUI=loadUIState();
tab=savedUI.tab || "shifts";
cursor=savedUI.cursor || ymOf(new Date());

/* ========== утилиты ========== */
function ymOf(d){
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

function ymLabel(ym){
  const [year,month]=ym.split("-");
  return MONTHS[Number(month)-1]+" "+year;
}

function monthNom(ym){return MONTHS[Number(ym.split("-")[1])-1].toLowerCase();}
function monthGen(ym){return MONTHS_G[Number(ym.split("-")[1])-1];}

function shiftMonth(ym,delta){
  const [year,month]=ym.split("-").map(Number);
  const date=new Date(year,month-1+delta,1,12);
  const shifted=ymOf(date);
  const shiftedYear=Number(shifted.slice(0,4));
  if(shiftedYear<MIN_YEAR) return `${MIN_YEAR}-01`;
  if(shiftedYear>MAX_YEAR) return `${MAX_YEAR}-12`;
  return shifted;
}

function lastDayOfMonth(ym){
  const [year,month]=ym.split("-").map(Number);
  return new Date(year,month,0).getDate();
}

function localYMD(date=new Date()){
  return date.getFullYear()+"-"+
    String(date.getMonth()+1).padStart(2,"0")+"-"+
    String(date.getDate()).padStart(2,"0");
}

function dateLabel(ymd){
  const [year,month,day]=ymd.split("-").map(Number);
  return day+" "+MONTHS_G[month-1]+" "+year;
}

function nf(number){
  return Math.round(number)
    .toLocaleString("ru-RU")
    .replace(/\s/g,"\u00A0");
}

function nfMoney(number){
  const cents=
    Math.round(
      Number(number)*100
    );

  const value=
    cents/100;

  return value
    .toLocaleString(
      "ru-RU",
      {
        minimumFractionDigits:
          Math.abs(cents)%100===0
            ? 0
            : 2,
        maximumFractionDigits:2
      }
    )
    .replace(/\s/g,"\u00A0");
}

function money(number){
  return nfMoney(number)+"\u00A0₽";
}
function esc(value){
  return String(value??"").replace(/[&<>\"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));
}

function hoursWord(hours){
  return Number(hours)+" ч";
}

function shiftsWord(n){
  const last=n%10,lastTwo=n%100;
  if(last===1 && lastTwo!==11) return n+" смена";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" смены";
  return n+" смен";
}

function shiftsAccWord(n){
  const last=n%10,lastTwo=n%100;
  if(last===1 && lastTwo!==11) return n+" смену";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" смены";
  return n+" смен";
}

function partialShortWord(n){
  const last=n%10,lastTwo=n%100;
  if(last===1 && lastTwo!==11) return n+" неполная";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" неполные";
  return n+" неполных";
}

function extraPartialShortWord(n){
  const last=n%10,lastTwo=n%100;
  if(last===1 && lastTwo!==11) return n+" доп. неполная";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" доп. неполные";
  return n+" доп. неполных";
}

function calc(shift){return domainCalc(shift);}
function inMonth(ym){return domainInMonth(shifts,ym);}
function payouts(ym){
  const result=domainPayouts(ym,shifts,{today:localYMD()});
  return {...result,nextYm:shiftMonth(ym,1)};
}
const FIXED_POINTS={has:value=>isFixedPoint(value)};

let appConfirmResolve=null;
let appConfirmPreviousFocus=null;
let toastTimer=null;

function focusableElements(container){
  return Array.from(container.querySelectorAll(
    'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter(element=>!element.hidden && element.getClientRects().length>0);
}

function activeModal(){
  const ids=["appConfirm","datePicker","pointPicker","monthPicker","sheet"];
  return ids.map(id=>document.getElementById(id)).find(element=>
    element && (element.classList.contains("on") || element.getAttribute("aria-hidden")==="false")
  ) || null;
}

function setBackgroundInert(enabled){
  [document.querySelector("header"),document.querySelector("main"),document.querySelector(".bottom-controls")]
    .filter(Boolean)
    .forEach(element=>{
      if(enabled) element.setAttribute("inert","");
      else element.removeAttribute("inert");
    });
}

function closeAppConfirm(result){
  const modal=document.getElementById("appConfirm");
  if(!modal.classList.contains("on")) return;

  modal.classList.remove("on");
  modal.setAttribute("aria-hidden","true");
  document.body.classList.remove("confirm-open");
  if(!activeModal()) setBackgroundInert(false);

  const resolve=appConfirmResolve;
  appConfirmResolve=null;
  if(resolve) resolve(result);

  setTimeout(()=>{
    if(appConfirmPreviousFocus && document.contains(appConfirmPreviousFocus)){
      appConfirmPreviousFocus.focus();
    }
    appConfirmPreviousFocus=null;
  },100);
}

function appConfirm(message,{okText="Подтвердить",danger=false,detail=""}={}){
  const modal=document.getElementById("appConfirm");
  const title=document.getElementById("appConfirmTitle");
  const detailElement=document.getElementById("appConfirmDetail");
  const ok=document.getElementById("appConfirmOk");
  const cancel=document.getElementById("appConfirmCancel");

  appConfirmPreviousFocus=document.activeElement;
  title.textContent=message;
  detailElement.textContent=detail;
  detailElement.hidden=!detail;
  ok.textContent=okText;
  ok.classList.toggle("danger",danger);
  modal.classList.add("on");
  modal.setAttribute("aria-hidden","false");
  document.body.classList.add("confirm-open");
  setBackgroundInert(true);
  setTimeout(()=>cancel.focus(),20);

  return new Promise(resolve=>{appConfirmResolve=resolve;});
}

function toast(message,duration=2200){
  const element=document.getElementById("toast");
  clearTimeout(toastTimer);
  element.textContent=message;
  element.classList.add("on");
  toastTimer=setTimeout(()=>element.classList.remove("on"),duration);
}

document.getElementById("appConfirmCancel").addEventListener("click",()=>closeAppConfirm(false));
document.getElementById("appConfirmOk").addEventListener("click",()=>closeAppConfirm(true));
document.getElementById("appConfirm").addEventListener("click",event=>{
  if(event.target.id==="appConfirm") closeAppConfirm(false);
});

document.addEventListener("keydown",event=>{
  const modal=activeModal();
  if(!modal) return;

  if(event.key==="Tab"){
    const items=focusableElements(modal);
    if(!items.length){event.preventDefault();return;}
    const first=items[0],last=items.at(-1);
    if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
    return;
  }

  if(event.key!=="Escape") return;
  event.preventDefault();

  if(document.getElementById("appConfirm").classList.contains("on")) return closeAppConfirm(false);
  if(document.getElementById("dateJump").classList.contains("on")) return closeDateJump();
  if(document.getElementById("datePicker").classList.contains("on")) return closeDatePicker();
  if(document.getElementById("pointPicker").classList.contains("on")) return closePointPicker();
  if(document.getElementById("monthPicker").classList.contains("on")) return closeMonthPicker();
  if(document.getElementById("sheet").classList.contains("on")) return closeSheet();
});

function isRecoverableDraft(value){
  return isPlainObject(value) &&
    typeof value.id==="string" &&
    isValidDateString(value.date) &&
    POINTS.includes(value.point) &&
    ["main","extra"].includes(value.type) &&
    typeof value.partial==="boolean";
}

function announceRevision(revision){
  try{syncChannel?.postMessage({type:"revision",revision});}catch{}
}

async function loadFromStorage({notify=false}={}){
  const result=await store.load();
  shifts=result.shifts;
  storageRevision=result.revision;
  hasBackup=result.hasBackup;
  storageOk=true;
  loadError=null;
  syncConflict=false;
  if(notify) toast("Данные обновлены из другой вкладки");
  return result;
}

async function load(){
  const pendingUI=loadUIState();

  try{
    await loadFromStorage();
  }catch(error){
    loadError=error;
    storageOk=false;
    shifts=[];
    storageRevision=null;
    try{hasBackup=Boolean(store.getBackupRaw());}catch{hasBackup=false;}
  }

  render();

  const savedDraft=
    pendingUI.draft;

  if(
    !loadError &&
    pendingUI.sheetOpen===true &&
    isRecoverableDraft(savedDraft)
  ){
    openSheet(
      savedDraft.id,
      savedDraft,
      pendingUI.sheetScrollTop || 0
    );
  }

  requestAnimationFrame(()=>{
    setPageScrollTop(
      pendingUI.scrollY || 0
    );

    document.body.classList.remove(
      "app-booting"
    );
  });
}

async function save(nextShifts=shifts){
  if(loadError){
    toast("Сначала восстановите или замените повреждённые данные",3500);
    return false;
  }

  try{
    const result=await store.save(nextShifts,{expectedRevision:storageRevision});
    storageRevision=result.revision;
    hasBackup=result.hasBackup;
    storageOk=true;
    syncConflict=false;
    announceRevision(storageRevision);
    return true;
  }catch(error){
    storageOk=false;
    if(error instanceof StorageConflictError){
      syncConflict=true;
      toast("Данные изменились в другой вкладке. Обновите данные перед сохранением.",4200);
    }else{
      toast("Не удалось сохранить данные",3200);
      console.error(error);
    }
    return false;
  }
}

function exportEnvelopeJson(){
  return JSON.stringify(
    createBackupEnvelope(shifts,{revision:storageRevision}),
    null,
    2
  );
}

function downloadText(text,filename,type="application/json"){
  const blob=new Blob([text],{type:`${type};charset=utf-8`});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;
  link.download=filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),0);
}

async function copyText(text){
  if(!navigator.clipboard?.writeText) return false;
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch{
    return false;
  }
}

function backupFilename(){
  return `shift-register-${localYMD()}-v${APP_VERSION}.json`;
}

function handleExternalRevision(){
  if(draft || document.body.classList.contains("sheet-open")){
    syncConflict=true;
    storageOk=false;
    toast("Данные изменены в другой вкладке. Закройте форму и обновите данные.",4200);
    return;
  }

  loadFromStorage({notify:true})
    .then(render)
    .catch(error=>{
      loadError=error;
      storageOk=false;
      render();
    });
}

window.addEventListener("storage",event=>{
  if([DB_KEY,LEGACY_DB_KEY,BACKUP_KEY].includes(event.key)){
    handleExternalRevision();
  }
});

syncChannel?.addEventListener("message",event=>{
  if(event.data?.type==="revision" && event.data.revision!==storageRevision){
    handleExternalRevision();
  }
});


/* ========== экраны ========== */
const app = document.getElementById("app");

function shouldShowFab(ym=cursor){
  return (
    tab==="shifts" &&
    inMonth(ym).length>0 &&
    !loadError
  );
}

function render(){
  saveUIState();

  if(loadError) tab="data";

  const period=document.getElementById("period");
  period.textContent=tab==="data" ? "Данные" : ymLabel(cursor);
  period.classList.toggle("clickable",tab!=="data");

  document.getElementById("prevM").disabled=tab!=="data" && cursor===`${MIN_YEAR}-01`;
  document.getElementById("nextM").disabled=tab!=="data" && cursor===`${MAX_YEAR}-12`;

  document.querySelectorAll("#prevM,#nextM").forEach(button=>{
    button.classList.toggle("is-hidden",tab==="data");
  });

  const showFab=shouldShowFab(cursor);
  const bottomControls=document.querySelector(".bottom-controls");
  const fab=document.getElementById("fab");

  bottomControls.classList.toggle("has-fab",showFab);
  fab.classList.toggle("is-hidden",!showFab);

  ["shifts","stats","data"].forEach(name=>{
    const button=document.getElementById("tab-"+name);
    const selected=name===tab;
    button.classList.toggle("on",selected);
    button.setAttribute("aria-selected",String(selected));
    button.tabIndex=selected ? 0 : -1;
  });

  app.classList.toggle(
    "shifts-layout",
    tab==="shifts"
  );

  app.innerHTML=
    tab==="shifts"
      ? viewShifts()
      : tab==="stats"
        ? viewStats()
        : viewData();

  requestAnimationFrame(
    fitShiftWindow
  );
}

function fitShiftWindow(){
  if(tab!=="shifts"){
    return;
  }

  const frame=
    app.querySelector(
      ".shift-window"
    );

  const scroller=
    app.querySelector(
      ".shift-scroll"
    );

  if(
    !(frame instanceof HTMLElement) ||
    !(scroller instanceof HTMLElement)
  ){
    return;
  }

  frame.style.removeProperty(
    "flex"
  );

  frame.style.removeProperty(
    "height"
  );

  const available=
    scroller.clientHeight;

  const rows=
    Array.from(
      scroller.querySelectorAll(
        ".sh"
      )
    );

  if(
    !rows.length ||
    available<=0
  ){
    return;
  }

  let fittedHeight=0;

  for(const row of rows){
    const rowHeight=
      row.getBoundingClientRect()
        .height;

    if(
      fittedHeight+
      rowHeight>
      available+0.5
    ){
      break;
    }

    fittedHeight+=
      rowHeight;
  }

  if(fittedHeight<=0){
    return;
  }

  const frameStyle=
    getComputedStyle(frame);

  const borderHeight=
    (
      parseFloat(
        frameStyle.borderTopWidth
      ) || 0
    )+
    (
      parseFloat(
        frameStyle.borderBottomWidth
      ) || 0
    );

  const targetHeight=
    Math.min(
      frame.getBoundingClientRect()
        .height,
      fittedHeight+
        borderHeight
    );

  frame.style.flex=
    `0 0 ${targetHeight}px`;

  frame.style.height=
    `${targetHeight}px`;
}

function viewShifts(){
  const list=inMonth(cursor);

  if(!list.length){
    return `
      <div class="ml">${shiftsWord(0)}</div>
      <div class="card">
        <div class="empty">
          <div>В этом месяце смен пока нет.</div>
          <button type="button" class="empty-add" id="emptyAdd">
            <span class="empty-add-plus" aria-hidden="true"></span>
            Добавить смену
          </button>
        </div>
      </div>
    `;
  }

  let html=`
    <div class="ml">${shiftsWord(list.length)}</div>

    <div class="card shift-window">
      <div
        class="shift-scroll"
        aria-label="Список смен"
      >
  `;

  for(const shift of list){
    const result=calc(shift);
    const parts=shift.date.split("-");
    const tags=[];

    if(shift.type==="extra"){
      tags.push(
        `<span class="tag g">Доп</span>`
      );
    }

    if(shift.partial){
      tags.push(
        `<span class="tag">${hoursWord(result.hours)}</span>`
      );
    }

    if(result.bonus>0){
      tags.push(
        `<span class="tag bonus">+${nfMoney(result.bonus)}</span>`
      );
    }

    if(result.fine>0){
      tags.push(
        `<span class="tag r">−${nfMoney(result.fine)}</span>`
      );
    }

    const shkLabel=
      result.fixed
        ? "Оклад"
        : `${shift.shk==="" ? "—" : nf(shift.shk)} ШК`;

    html+=`
      <button
        type="button"
        class="sh"
        data-edit="${esc(shift.id)}"
        aria-label="${esc(dateLabel(shift.date))}, ${esc(shift.point)}, ${money(result.total)}"
      >
        <span class="day">
          <span class="d">${Number(parts[2])}</span>
          <span class="w">${WD[new Date(shift.date+"T12:00:00").getDay()]}</span>
        </span>

        <span class="mid">
          <span class="p">${esc(shift.point)}</span>

          <span class="meta">
            <span>${shkLabel} · ${nf(result.rate)} ₽</span>
            ${tags.join("")}
          </span>
        </span>

        <span class="amt">${money(result.total)}</span>
      </button>
    `;
  }

  return html+`
      </div>
    </div>
  `;
}

function viewStats(){
  const payout=
    payouts(cursor);

  const aggregate=
    payout.all;

  const monthShifts=
    inMonth(cursor);

  const today=
    localYMD();

  const workedShifts=
    monthShifts.filter(
      shift=>
        shift.date<=today
    );

  const plannedShifts=
    monthShifts.filter(
      shift=>
        shift.date>today
    );

  const groupDetails=list=>{
    const details=[];

    const counts=
      list.reduce(
        (
          result,
          shift
        )=>{
          if(
            shift.type==="extra" &&
            shift.partial
          ){
            result.extraPartial++;
          }

          else if(
            shift.type==="extra"
          ){
            result.extra++;
          }

          else if(
            shift.partial
          ){
            result.partial++;
          }

          return result;
        },
        {
          extraPartial:0,
          extra:0,
          partial:0
        }
      );

    if(counts.extraPartial){
      details.push(
        extraPartialShortWord(
          counts.extraPartial
        )
      );
    }

    if(counts.extra){
      details.push(
        counts.extra+" доп."
      );
    }

    if(counts.partial){
      details.push(
        partialShortWord(
          counts.partial
        )
      );
    }

    return details.length
      ? ` (${details.join(", ")})`
      : "";
  };

  const statusParts=[];

  if(workedShifts.length){
    statusParts.push(
      `отработано ${workedShifts.length}${groupDetails(workedShifts)}`
    );
  }

  if(plannedShifts.length){
    statusParts.push(
      `запланировано ${plannedShifts.length}${groupDetails(plannedShifts)}`
    );
  }

  const shiftsSummary=
    statusParts.length
      ? `${shiftsWord(aggregate.n)}: ${statusParts.join(", ")}`
      : shiftsWord(aggregate.n);

  const paymentBaseLine=(
    label,
    amount
  )=>{
    if(!amount){
      return "";
    }

    return `
      <div class="s">
        ${label}:
        ${money(amount)}
      </div>
    `;
  };

  const bonusLine=amount=>{
    if(!amount){
      return "";
    }

    return `
      <div class="s">
        Премии:
        <span class="pos">
          + ${money(amount)}
        </span>
      </div>
    `;
  };

  const fineLine=amount=>{
    if(!amount){
      return "";
    }

    const correction=
      amount<0;

    return `
      <div class="s">
        ${
          correction
            ? "Корректировка штрафов:"
            : "Штрафы:"
        }
        <span class="${
          correction
            ? "pos"
            : "neg"
        }">
          ${
            correction
              ? "+"
              : "−"
          }
          ${money(
            Math.abs(amount)
          )}
        </span>
      </div>
    `;
  };

  const payment25Lines=[
    paymentBaseLine(
      "Авансные ПВЗ",
      payout.specialAdvance
    ),

    paymentBaseLine(
      "Остальные ПВЗ",
      payout.regularFirstBase
    ),

    bonusLine(
      payout.bonus25
    ),

    fineLine(
      payout.fine25
    )
  ].join("");

  const payment10Lines=[
    paymentBaseLine(
      "Авансные ПВЗ",
      payout.specialSecondHalfBase
    ),

    paymentBaseLine(
      "Перенос сверх лимита аванса",
      payout.specialCarry
    ),

    paymentBaseLine(
      "Остальные ПВЗ",
      payout.regularSecondBase
    ),

    bonusLine(
      payout.bonus10
    ),

    fineLine(
      payout.fine10
    )
  ].join("");

  const payment25Content=
    payment25Lines ||
    `
      <div class="s">
        Расчёт за 1–15 ${esc(monthGen(cursor))}
      </div>
    `;

  const payment10Content=
    payment10Lines ||
    `
      <div class="s">
        Окончательный расчёт за ${esc(monthNom(cursor))}
      </div>
    `;

  const fineTransferNotes=
    payout.otherFinePayments
      .map(item=>{
        const correction=
          item.amount<0;

        const alreadyApplied=
          item.date<=today;

        return `
          <div class="note">
            ${
              correction
                ? "Корректировка штрафов"
                : "Штрафы"
            }
            за ${esc(monthNom(cursor))}
            <span class="${
              correction
                ? "pos"
                : "neg"
            }">
              ${
                correction
                  ? "+"
                  : "−"
              }
              ${money(
                Math.abs(
                  item.amount
                )
              )}
            </span>
            ${
              alreadyApplied
                ? "учтены"
                : "учтутся"
            }
            в выплате
            ${esc(
              dateLabel(
                item.date
              )
            )}.
          </div>
        `;
      })
      .join("");

  return `
    <div class="card">
      <div class="hero">
        <div class="k">
          Начислено
        </div>

        <div class="n ${
          String(
            Math.abs(
              Math.round(
                aggregate.total
              )
            )
          ).startsWith("1")
            ? "starts-one"
            : ""
        }">
          ${nfMoney(aggregate.total)}
          <small> ₽</small>
        </div>

        <div class="sub">
          ${shiftsSummary}
        </div>
      </div>
    </div>


    <div class="ml">
      Выплаты
    </div>

    <div class="card">
      <div class="row">
        <div class="l">
          <div class="t">
            25 ${esc(monthGen(cursor))}
          </div>

          ${payment25Content}
        </div>

        <div class="v ${
          payout.payment25<0
            ? "neg"
            : ""
        }">
          ${money(
            payout.payment25
          )}
        </div>
      </div>

      <div class="row">
        <div class="l">
          <div class="t">
            10 ${esc(
              monthGen(
                payout.nextYm
              )
            )}
          </div>

          ${payment10Content}
        </div>

        <div class="v ${
          payout.payment10<0
            ? "neg"
            : ""
        }">
          ${money(
            payout.payment10
          )}
        </div>
      </div>
    </div>

    ${fineTransferNotes}

    <div class="ml">
      За месяц
    </div>

    <div class="card">
      <div class="row">
        <div class="l">
          <div class="t">
            Смены
          </div>
        </div>

        <div class="v">
          ${money(aggregate.base)}
        </div>
      </div>

      <div class="row">
        <div class="l">
          <div class="t">
            Премии
          </div>
        </div>

        <div class="v pos">
          ${
            aggregate.bonus
              ? "+ "
              : ""
          }
          ${money(
            aggregate.bonus
          )}
        </div>
      </div>

      <div class="row">
        <div class="l">
          <div class="t">
            Штрафы
          </div>
        </div>

        <div class="v neg">
          ${
            aggregate.fine
              ? "− "
              : ""
          }
          ${money(
            aggregate.fine
          )}
        </div>
      </div>

      <div class="row total">
        <div class="l">
          <div class="t">
            Итого за
            ${esc(monthNom(cursor))}
          </div>
        </div>

        <div class="v">
          ${money(
            aggregate.total
          )}
        </div>
      </div>
    </div>
  `;
}

function viewData(){
  let title;
  let detail;
  let statusClass="";

  if(loadError){
    title="Ошибка данных";
    detail="Можно восстановить сохранённую копию или заменить данные.";
    statusClass="off";
  }else if(syncConflict){
    title="Конфликт изменений";
    detail="Обновите данные перед следующей записью.";
    statusClass="off";
  }else if(store.mode==="memory"){
    title="Временное хранение";
    detail=`${shiftsWord(shifts.length)} · только до закрытия страницы`;
    statusClass="off";
  }else if(!storageOk){
    title="Ошибка сохранения";
    detail="Последнее изменение не сохранено.";
    statusClass="off";
  }else{
    title="Данные сохранены";
    detail="";
  }

  const recoveryActions=loadError
    ? `
      <button class="btn" id="doRawExport">Скачать исходные данные</button>
      ${hasBackup?`<button class="btn gold" id="doRestoreBackup">Восстановить исправную копию</button>`:""}

      <div class="ml">Резервная копия</div>
      <textarea id="dataImportInput" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Вставьте исправную копию сюда"></textarea>
      <button class="btn gold" id="doImport">Заменить данные</button>
    `
    : syncConflict
      ? `<button class="btn gold" id="doReloadData">Обновить данные</button>`
      : "";

  const backupAction=hasBackup && !loadError
    ? `<button class="btn" id="doRestoreBackup">Восстановить предыдущую версию</button>`
    : "";

  return `
    <div class="ml">Хранилище</div>
    <div class="data-status">
      <div class="dot ${statusClass}"></div>
      <div class="data-status-copy">
        <div class="data-status-title">
          ${esc(title)}${!detail?`: <span class="data-status-count">${esc(shiftsWord(shifts.length))}</span>`:""}
        </div>
        ${detail?`<div class="data-status-detail">${esc(detail)}</div>`:""}
      </div>
    </div>

    ${recoveryActions}

    ${loadError?"":`
      <div class="ml">Резервная копия</div>
      <button class="btn gold" id="doExport">Скачать копию</button>
      <button class="btn" id="doImportToggle">Загрузить копию</button>

      <div id="dataImportPanel" hidden>
        <textarea id="dataImportInput" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Вставьте резервную копию сюда"></textarea>
        <button class="btn gold" id="doImport">Загрузить</button>
      </div>

      ${backupAction}

      <button class="btn warn" id="doWipe">Удалить все смены</button>
    `}

    <div class="developer-credit">
      <div>Версия: Shift Register ${APP_VERSION}</div>
      <div>Разработчик: emilsvifullin</div>
    </div>
  `;
}

/* ========== форма ========== */
function defaultShiftDate(){
  const today=localYMD();

  if(cursor===today.slice(0,7)){
    return today;
  }

  const [year,month]=
    cursor
      .split("-")
      .map(Number);

  const todayDay=
    Number(
      today.slice(8,10)
    );

  const lastDay=
    new Date(
      year,
      month,
      0,
      12
    ).getDate();

  const day=
    Math.min(
      todayDay,
      lastDay
    );

  return (
    cursor+
    "-"+
    String(day).padStart(2,"0")
  );
}

function openSheet(id,restoredDraft=null,restoredScrollTop=0){
  if(loadError){
    tab="data";
    render();
    toast("Сначала восстановите данные",3000);
    return;
  }

  const sheet=document.getElementById("sheet");
  const savedShift=shifts.find(item=>item.id===id);
  sheetPreviousFocus=document.activeElement;
  sheet.style.display="block";
  sheet.style.removeProperty("transition");
  sheet.style.removeProperty("--sheet-drag");

  draft=restoredDraft
    ? {...restoredDraft}
    : savedShift
      ? {...savedShift}
      : {
          v:3,
          id:createShiftId(),
          date:defaultShiftDate(),
          point:POINTS[0],
          type:"main",
          shk:"",
          partial:false,
          hours:"",
          bonus:"",
          fine:""
        };

  const isEdit=Boolean(savedShift);
  document.getElementById("sheetTitle").textContent=isEdit ? "Смена" : "Новая смена";
  drawSheet(isEdit);

  const restoring=Boolean(restoredDraft);
  const veil=document.getElementById("veil");
  sheet.classList.remove("on");
  sheet.setAttribute("aria-hidden","false");
  veil.setAttribute("aria-hidden","false");
  setBackgroundInert(true);

  if(restoring){
    sheet.style.transition="none";
    veil.style.transition="none";
  }

  void sheet.offsetHeight;
  document.body.classList.add("sheet-open");
  veil.classList.add("on");
  sheet.classList.add("on");

  if(restoring){
    sheet.scrollTop=Math.max(
      0,
      restoredScrollTop
    );

    void sheet.offsetHeight;

    requestAnimationFrame(()=>{
      sheet.style.removeProperty(
        "transition"
      );

      veil.style.removeProperty(
        "transition"
      );

      sheet.focus({
        preventScroll:true
      });
    });
  }else{
    requestAnimationFrame(()=>{
      sheet.scrollTop=Math.max(
        0,
        restoredScrollTop
      );

      sheet.focus({
        preventScroll:true
      });
    });
  }

  saveUIState();
}

function closeSheet(){
  const sheet=document.getElementById("sheet");

  if(document.getElementById("datePicker").classList.contains("on")) closeDatePicker();
  if(document.getElementById("pointPicker").classList.contains("on")) closePointPicker();

  const veil=document.getElementById("veil");
  veil.classList.remove("on");
  veil.setAttribute("aria-hidden","true");
  sheet.classList.remove("on");
  sheet.setAttribute("aria-hidden","true");
  document.body.classList.remove("sheet-open");

  draft=null;
  saveUIState();
  if(!activeModal()) setBackgroundInert(false);

  const previousFocus=sheetPreviousFocus;
  sheetPreviousFocus=null;

  setTimeout(()=>{
    if(!sheet.classList.contains("on")) sheet.style.display="none";
    sheet.style.removeProperty("transition");
    sheet.style.removeProperty("--sheet-drag");
    if(previousFocus && document.contains(previousFocus)) previousFocus.focus();
  },500);
}

let datePickerHideTimer;
let dateCalendarCursor="";
let datePickerValue="";
let dateJumpYear=0;
let dateJumpValue="";
let dateSwipe=null;
let dateSwipeBlockClick=false;

function drawDatePicker(){
  const [year,month]=dateCalendarCursor.split("-").map(Number);

  document.getElementById("datePickerMonth").textContent=
    MONTHS[month-1]+" "+year;

  document.getElementById("datePrev").disabled=dateCalendarCursor===`${MIN_YEAR}-01`;
  document.getElementById("dateNext").disabled=dateCalendarCursor===`${MAX_YEAR}-12`;

  const firstDay=new Date(year,month-1,1,12);
  const mondayOffset=(firstDay.getDay()+6)%7;

  const gridStart=new Date(
    year,
    month-1,
    1-mondayOffset,
    12
  );

  const today=localYMD();

  let html="";

  for(let index=0;index<42;index++){
    const day=new Date(gridStart);

    day.setDate(gridStart.getDate()+index);

    const ymd=localYMD(day);
    const outside=day.getMonth()!==month-1;
    const selected=ymd===datePickerValue;
    const isToday=ymd===today;
    const outOfRange=day.getFullYear()<MIN_YEAR || day.getFullYear()>MAX_YEAR;

    html+=`
      <button
        type="button"
        class="date-day
          ${outside?"outside":""}
          ${selected?"on":""}
          ${isToday?"today":""}
        "
        data-date="${ymd}"
        aria-label="${esc(dateLabel(ymd))}"
        ${outOfRange?"disabled":""}
      >
        ${day.getDate()}
      </button>
    `;
  }

  document.getElementById("dateGrid").innerHTML=html;
}

function drawDateJump(){
  document.getElementById("dateJumpYear").textContent=
    dateJumpYear;

  document.getElementById("dateJumpPrevYear").disabled=dateJumpYear<=MIN_YEAR;
  document.getElementById("dateJumpNextYear").disabled=dateJumpYear>=MAX_YEAR;

  document.getElementById("dateJumpMonths").innerHTML=
    MONTHS.map((month,index)=>{
      const ym=
        dateJumpYear+"-"+
        String(index+1).padStart(2,"0");

      return `
        <button
          type="button"
          class="date-jump-month ${ym===dateJumpValue?"on":""}"
          data-calendar-month="${ym}"
        >
          ${month}
        </button>
      `;
    }).join("");
}

let dateCalendarTransitionRunning=false;

function makeDateCalendarGhost(
  element,
  picker
){
  const rect=
    element.getBoundingClientRect();

  const pickerRect=
    picker.getBoundingClientRect();

  const ghost=
    element.cloneNode(true);

  ghost.removeAttribute("id");
  ghost.setAttribute(
    "aria-hidden",
    "true"
  );
  ghost.setAttribute(
    "inert",
    ""
  );

  ghost.style.position="absolute";

  ghost.style.left=
    rect.left-pickerRect.left+"px";

  ghost.style.top=
    rect.top-pickerRect.top+"px";

  ghost.style.width=
    rect.width+"px";

  ghost.style.height=
    rect.height+"px";

  ghost.style.margin="0";
  ghost.style.zIndex="5";
  ghost.style.pointerEvents="none";

  picker.appendChild(ghost);

  return ghost;
}

function changeDateCalendarMonth(
  nextCursor,
  direction,
  {value}={}
){
  if(
    !nextCursor ||
    dateCalendarTransitionRunning
  ){
    return;
  }

  if(
    nextCursor===dateCalendarCursor
  ){
    if(value!==undefined){
      datePickerValue=value;
      drawDatePicker();
    }

    return;
  }

  const grid=
    document.getElementById(
      "dateGrid"
    );

  const title=
    document.getElementById(
      "datePickerMonth"
    );

  const picker=
    document.getElementById(
      "datePicker"
    );

  const apply=()=>{
    dateCalendarCursor=
      nextCursor;

    if(value!==undefined){
      datePickerValue=value;
    }

    drawDatePicker();
  };

  if(
    prefersReducedMotion() ||
    typeof grid.animate!=="function"
  ){
    apply();
    return;
  }

  dateCalendarTransitionRunning=true;

  const oldGrid=
    makeDateCalendarGhost(
      grid,
      picker
    );

  const oldTitle=
    makeDateCalendarGhost(
      title,
      picker
    );

  apply();

  grid.style.pointerEvents="none";

  const oldX=
    direction>0
      ? -28
      : 28;

  const newX=
    -oldX;

  const oldTitleX=
    direction>0
      ? -10
      : 10;

  const newTitleX=
    -oldTitleX;

  const options={
    duration:320,
    easing:
      "cubic-bezier(.22,.72,.22,1)",
    fill:"both"
  };

  const animations=[
    oldGrid.animate(
      [
        {
          opacity:1,
          transform:
            "translate3d(0,0,0)"
        },
        {
          opacity:0,
          transform:
            `translate3d(${oldX}px,0,0)`
        }
      ],
      options
    ),

    grid.animate(
      [
        {
          opacity:0,
          transform:
            `translate3d(${newX}px,0,0)`
        },
        {
          opacity:1,
          transform:
            "translate3d(0,0,0)"
        }
      ],
      options
    ),

    oldTitle.animate(
      [
        {
          opacity:1,
          transform:
            "translate3d(0,0,0)"
        },
        {
          opacity:0,
          transform:
            `translate3d(${oldTitleX}px,0,0)`
        }
      ],
      options
    ),

    title.animate(
      [
        {
          opacity:0,
          transform:
            `translate3d(${newTitleX}px,0,0)`
        },
        {
          opacity:1,
          transform:
            "translate3d(0,0,0)"
        }
      ],
      options
    )
  ];

  Promise.allSettled(
    animations.map(
      animation=>animation.finished
    )
  ).finally(()=>{
    animations.forEach(
      animation=>animation.cancel()
    );

    oldGrid.remove();
    oldTitle.remove();

    grid.style.removeProperty(
      "pointer-events"
    );

    dateCalendarTransitionRunning=false;
  });
}

function openDateJump(){
  dateJumpValue=
    dateCalendarCursor;

  dateJumpYear=
    Number(
      dateJumpValue.slice(0,4)
    );

  drawDateJump();

  document
    .getElementById("dateJump")
    .classList.add("on");

  document
    .getElementById("datePicker")
    .classList.add("jump-open");

  document
    .getElementById("datePickerMonth")
    .setAttribute(
      "aria-expanded",
      "true"
    );
}

function closeDateJump(){
  document.getElementById("dateJump").classList.remove("on");
  document.getElementById("datePicker").classList.remove("jump-open");

  document
    .getElementById("datePickerMonth")
    .setAttribute("aria-expanded","false");
}

document.getElementById("dateJumpDismiss").addEventListener(
  "click",
  e=>{
    e.preventDefault();
    e.stopImmediatePropagation();
    closeDateJump();
  }
);

function toggleDateJump(){
  const jump=document.getElementById("dateJump");

  if(jump.classList.contains("on")){
    closeDateJump();
  } else {
    openDateJump();
  }
}

function openDatePicker(){
  if(!draft) return;

  readForm();
  datePreviousFocus=document.activeElement;
  const picker=document.getElementById("datePicker");
  const veil=document.getElementById("dateVeil");
  clearTimeout(datePickerHideTimer);
  picker.style.removeProperty("--date-drag");

  datePickerValue=draft.date;
  dateCalendarCursor=datePickerValue.slice(0,7);
  closeDateJump();
  drawDatePicker();

  picker.style.display="block";
  picker.classList.remove("on");
  picker.style.removeProperty("transition");
  picker.setAttribute("aria-hidden","false");
  veil.setAttribute("aria-hidden","false");
  document.body.classList.add("date-picker-open");
  veil.classList.add("on");
  void picker.offsetHeight;
  picker.classList.add("on");
  requestAnimationFrame(()=>document.getElementById("dateCancel").focus());
}

function closeDatePicker(){
  const picker=document.getElementById("datePicker");
  if(!picker.classList.contains("on") && picker.getAttribute("aria-hidden")==="true") return;

  closeDateJump();
  picker.style.removeProperty("transition");
  picker.classList.remove("on");
  picker.setAttribute("aria-hidden","true");

  const veil=document.getElementById("dateVeil");
  veil.classList.remove("on");
  veil.setAttribute("aria-hidden","true");
  document.body.classList.remove("date-picker-open");
  clearTimeout(datePickerHideTimer);

  const previousFocus=datePreviousFocus;
  datePreviousFocus=null;
  datePickerHideTimer=setTimeout(()=>{
    if(!picker.classList.contains("on")) picker.style.display="none";
    picker.style.removeProperty("--date-drag");
    picker.style.removeProperty("transition");
    if(previousFocus && document.contains(previousFocus)) previousFocus.focus();
  },460);
}

function selectDate(ymd){
  if(!draft) return;

  draft.date=ymd;

  closeDatePicker();

  const isEdit=shifts.some(item=>item.id===draft.id);

  drawSheet(isEdit);
  saveUIState();
}

let pointPickerHideTimer;
let pointPickerValue="";

function openPointPicker(){
  if(!draft) return;

  pointPreviousFocus=document.activeElement;
  const list=document.getElementById("pointList");
  const picker=document.getElementById("pointPicker");
  const veil=document.getElementById("pointVeil");
  clearTimeout(pointPickerHideTimer);

  picker.style.display="block";
  picker.classList.remove("on");
  picker.style.removeProperty("transition");
  picker.style.removeProperty("--point-drag");
  picker.setAttribute("aria-hidden","false");
  veil.setAttribute("aria-hidden","false");

  pointPickerValue=draft.point;

  list.innerHTML=POINTS.map(point=>`
    <button
      type="button"
      class="point-option ${point===pointPickerValue?"on":""}"
      data-point="${esc(point)}"
    >
      <span class="point-check">
        ${point===pointPickerValue?"✓":""}
      </span>

      <span class="point-name">
        ${esc(point)}
      </span>
    </button>
  `).join("");

  document.body.classList.add("point-picker-open");
  veil.classList.add("on");
  void picker.offsetHeight;
  picker.classList.add("on");

  requestAnimationFrame(()=>{
    const selected=list.querySelector(".point-option.on") || list.querySelector(".point-option");
    if(selected){
      selected.scrollIntoView({block:"center"});
      selected.focus();
    }
  });
}

function closePointPicker(){
  const picker=document.getElementById("pointPicker");
  if(!picker.classList.contains("on") && picker.getAttribute("aria-hidden")==="true") return;

  picker.style.removeProperty("transition");
  picker.classList.remove("on");
  picker.setAttribute("aria-hidden","true");

  const veil=document.getElementById("pointVeil");
  veil.classList.remove("on");
  veil.setAttribute("aria-hidden","true");
  document.body.classList.remove("point-picker-open");
  clearTimeout(pointPickerHideTimer);

  const previousFocus=pointPreviousFocus;
  pointPreviousFocus=null;
  pointPickerHideTimer=setTimeout(()=>{
    if(!picker.classList.contains("on")) picker.style.display="none";
    picker.style.removeProperty("--point-drag");
    if(previousFocus && document.contains(previousFocus)) previousFocus.focus();
  },460);
}

function previewCalc(value){
  const existing=shifts.find(item=>item.id===value.id);
  let pricing;

  try{
    pricing=(existing?.pricing && pricingDriversEqual(existing,value))
      ? existing.pricing
      : snapshotPricing(value);
  }catch{
    pricing={fixed:false,rate:0,fullHours:FULL_HOURS,rulesVersion:RULES_VERSION};
  }

  const hours=value.partial ? (Number(value.hours)||0) : pricing.fullHours;
  const perHour=pricing.rate/pricing.fullHours;
  const base=value.partial ? Math.round(perHour*hours) : pricing.rate;
  const bonus=Number(value.bonus)||0;
  const fine=Number(value.fine)||0;

  return {
    fixed:pricing.fixed,
    rate:pricing.rate,
    hours,
    perHour,
    base,
    bonus,
    fine,
    total:base+bonus-fine
  };
}

function calcHTML(){
  const result=previewCalc(draft);
  return `
    <div class="ln">
      <span>${result.fixed ? "Оклад смены" : "Ставка по объёму"}</span>
      <b>${money(result.rate)}</b>
    </div>
    ${draft.partial?`<div class="ln"><span>${nf(result.perHour)} ₽/час × ${hoursWord(result.hours)}</span><b>${money(result.base)}</b></div>`:""}
    ${result.bonus?`<div class="ln"><span>Премии</span><b class="pos">+ ${money(result.bonus)}</b></div>`:""}
    ${result.fine?`<div class="ln"><span>Штрафы</span><b class="neg">− ${money(result.fine)}</b></div>`:""}
    <div class="tot"><span>За смену</span><span>${money(result.total)}</span></div>`;
}

function drawSheet(isEdit){
  const fixed=isFixedPoint(draft.point);

  document.getElementById("sheetBody").innerHTML=`
    <div class="ml">Смена</div>
    <div class="card">
      <button type="button" class="row point-row" id="f-date-open">
        <div class="t">Дата</div>
        <div class="point-value">${esc(dateLabel(draft.date))}</div>
      </button>
      <button type="button" class="row point-row" id="f-point-open">
        <div class="t">Пункт</div>
        <div class="point-value">${esc(draft.point)}</div>
      </button>
      ${fixed ? "" : `
        <label class="row">
          <div class="t">ШК</div>
          <input type="number" inputmode="numeric" id="f-shk" min="0" max="${MAX_SHK}" step="1" value="${esc(draft.shk)}" placeholder="0" aria-label="ШК">
        </label>
      `}
    </div>

    <div class="ml">Тип</div>
    <div class="card segbox"><div class="seg">
      <button type="button" data-type="main" class="${draft.type==="main"?"on":""}">Основная</button>
      <button type="button" data-type="extra" class="${draft.type==="extra"?"on":""}">Дополнительная</button>
    </div></div>

    <div class="ml">Отработано</div>
    <div class="card">
      <div class="segbox"><div class="seg">
        <button type="button" data-part="0" class="${!draft.partial?"on":""}">Полная смена</button>
        <button type="button" data-part="1" class="${draft.partial?"on":""}">Неполная смена</button>
      </div></div>
      ${draft.partial?`<label class="row"><div class="t">Часов</div><input type="text" inputmode="decimal" id="f-hours" value="${esc(draft.hours==="" ? "" : String(draft.hours).replace(".",","))}" placeholder="0" aria-label="Часов"></label>`:""}
    </div>

    <div class="ml">Премии и штрафы</div>
    <div class="card">
      <label class="row"><div class="t">Премии</div><input type="text" inputmode="decimal" id="f-bonus" value="${esc(draft.bonus==="" ? "" : String(draft.bonus).replace(".",","))}" placeholder="0" aria-label="Премии"></label>
      <label class="row"><div class="t">Штрафы</div><input type="text" inputmode="decimal" id="f-fine" value="${esc(draft.fine==="" ? "" : String(draft.fine).replace(".",","))}" placeholder="0" aria-label="Штрафы"></label>
    </div>

    <div class="ml">Расчёт</div>
    <div class="calc" id="calcBox">${calcHTML()}</div>
    ${isEdit?`<button type="button" class="btn warn" id="f-del">Удалить смену</button>`:""}
    <div class="sheet-spacer" aria-hidden="true"></div>`;
}

function readForm(){
  const get=id=>document.getElementById(id);

  if(get("f-shk")){
    draft.shk=
      get("f-shk").value;
  }

  if(get("f-hours")){
    const value=
      get("f-hours")
        .value
        .trim();

    draft.hours=
      value===""
        ? ""
        : Number(
            value.replace(",",".")
          );
  }

  if(get("f-bonus")){
    const value=
      get("f-bonus")
        .value
        .trim();

    draft.bonus=
      value===""
        ? ""
        : value.replace(",",".");
  }

  if(get("f-fine")){
    const value=
      get("f-fine")
        .value
        .trim();

    draft.fine=
      value===""
        ? ""
        : value.replace(",",".");
  }
}

function validateWholeField(value,label,{allowEmpty=true,max=Number.MAX_SAFE_INTEGER}={}){
  if(value==="" || value===null || value===undefined){
    return allowEmpty ? null : `${label} не заполнено`;
  }

  const number=Number(value);
  if(!Number.isSafeInteger(number) || number<0 || number>max){
    return `${label} должно быть целым числом от 0 до ${nf(max)}`;
  }
  return null;
}

function validateMoneyField(value,label,{allowEmpty=true,max=MAX_MONEY}={}){
  if(value==="" || value===null || value===undefined){
    return allowEmpty ? null : `${label} не заполнено`;
  }

  const number=
    Number(
      typeof value==="string"
        ? value.replace(",",".")
        : value
    );

  if(!Number.isFinite(number)){
    return `${label} должно быть числом`;
  }

  const cents=
    Math.round(
      number*100
    );

  if(
    number<0 ||
    number>max ||
    Math.abs(
      number*100-cents
    )>1e-7
  ){
    return `${label} должно быть от 0 до ${nf(max)} ₽, не более 2 знаков после запятой`;
  }

  return null;
}

function validateDraft(value){
  if(!isValidDateString(value.date)) return {message:`Выберите дату с ${MIN_YEAR} по ${MAX_YEAR} год`,fieldId:"f-date-open"};
  if(!POINTS.includes(value.point)) return {message:"Выберите пункт",fieldId:"f-point-open"};

  if(!isFixedPoint(value.point)){
    const error=validateWholeField(value.shk,"ШК",{allowEmpty:true,max:MAX_SHK});
    if(error) return {message:error,fieldId:"f-shk"};
  }

  if(value.partial){
    const hours=
      Number(
        typeof value.hours==="string"
          ? value.hours.replace(",",".")
          : value.hours
      );

    const maxPartialHours=
      FULL_HOURS-0.5;

    if(
      !Number.isFinite(hours) ||
      hours<0.5 ||
      hours>maxPartialHours ||
      !Number.isInteger(hours*2)
    ){
      return {
        message:
          `Укажите часы от 0,5 до ${String(maxPartialHours).replace(".",",")} с шагом 0,5`,
        fieldId:"f-hours"
      };
    }
  }

  const bonusError=validateMoneyField(value.bonus,"Премия",{max:MAX_MONEY});
  if(bonusError) return {message:bonusError,fieldId:"f-bonus"};
  const fineError=validateMoneyField(value.fine,"Штраф",{max:MAX_MONEY});
  if(fineError) return {message:fineError,fieldId:"f-fine"};

  try{
    normalizeDraftForSave(value,shifts.find(item=>item.id===value.id) || null);
  }catch(error){
    return {message:error instanceof Error ? error.message : "Некорректные данные смены",fieldId:null};
  }

  return null;
}

function normalizedDraft(value){
  return normalizeDraftForSave(
    value,
    shifts.find(
      item=>item.id===value.id
    ) || null,
    {
      recordedOn:localYMD()
    }
  );
}

function showValidationError(error){
  toast(error.message,3000);

  setTimeout(()=>{
    const field=document.getElementById(error.fieldId);
    if(field) field.focus();
  },50);
}

let monthPickerHideTimer;
let monthPickerValue=cursor;
let monthPickerYear=Number(cursor.slice(0,4));

function drawMonthPicker(){
  const grid=
    document.getElementById("monthGrid");

  document
    .getElementById("monthPickerYear")
    .textContent=monthPickerYear;

  document.getElementById("monthYearPrev").disabled=monthPickerYear<=MIN_YEAR;
  document.getElementById("monthYearNext").disabled=monthPickerYear>=MAX_YEAR;

  grid.innerHTML=MONTHS.map(
    (name,index)=>{
      const ym=
        monthPickerYear+"-"+
        String(index+1).padStart(2,"0");

      return `
        <button
          type="button"
          class="
            month-option
            ${ym===monthPickerValue?"on":""}
          "
          data-month="${ym}"
        >
          ${name}
        </button>
      `;
    }
  ).join("");
}

function openMonthPicker(){
  if(
    tab==="data" ||
    document.body.classList.contains("sheet-open") ||
    document.body.classList.contains("point-picker-open")
  ) return;

  monthPreviousFocus=document.activeElement;
  const picker=document.getElementById("monthPicker");
  const veil=document.getElementById("monthVeil");
  clearTimeout(monthPickerHideTimer);
  picker.style.removeProperty("--month-drag");
  picker.style.removeProperty("transition");

  monthPickerValue=cursor;
  monthPickerYear=Math.min(MAX_YEAR,Math.max(MIN_YEAR,Number(monthPickerValue.slice(0,4))));
  drawMonthPicker();
  picker.style.display="block";
  picker.classList.remove("on");
  picker.setAttribute("aria-hidden","false");
  veil.setAttribute("aria-hidden","false");
  document.body.classList.add("month-picker-open");
  veil.classList.add("on");
  setBackgroundInert(true);
  void picker.offsetHeight;
  picker.classList.add("on");
  requestAnimationFrame(()=>document.getElementById("monthCancel").focus());
}

function closeMonthPicker(){
  const picker=document.getElementById("monthPicker");
  if(!picker.classList.contains("on") && picker.getAttribute("aria-hidden")==="true") return;

  picker.style.removeProperty("transition");
  picker.classList.remove("on");
  picker.setAttribute("aria-hidden","true");
  const veil=document.getElementById("monthVeil");
  veil.classList.remove("on");
  veil.setAttribute("aria-hidden","true");
  document.body.classList.remove("month-picker-open");
  clearTimeout(monthPickerHideTimer);

  const previousFocus=monthPreviousFocus;
  monthPreviousFocus=null;
  if(!activeModal()) setBackgroundInert(false);

  monthPickerHideTimer=setTimeout(()=>{
    if(!picker.classList.contains("on")) picker.style.display="none";
    picker.style.removeProperty("--month-drag");
    picker.style.removeProperty("transition");
    if(previousFocus && document.contains(previousFocus)) previousFocus.focus();
  },460);
}

let monthTransitionRunning=false;
let tabTransitionRunning=false;

function prefersReducedMotion(){
  return window.matchMedia?.(
    "(prefers-reduced-motion: reduce)"
  ).matches===true;
}

function makeMonthTransitionGhost(
  element,
  zIndex
){
  const rect=
    element.getBoundingClientRect();

  const ghost=
    element.cloneNode(true);

  ghost.removeAttribute(
    "id"
  );

  ghost
    .querySelectorAll("[id]")
    .forEach(node=>{
      node.removeAttribute(
        "id"
      );
    });

  ghost.setAttribute(
    "aria-hidden",
    "true"
  );

  ghost.setAttribute(
    "inert",
    ""
  );

  ghost.style.position=
    "fixed";

  ghost.style.left=
    rect.left+"px";

  ghost.style.top=
    rect.top+"px";

  ghost.style.width=
    rect.width+"px";

  ghost.style.height=
    rect.height+"px";

  ghost.style.margin=
    "0";

  ghost.style.zIndex=
    String(zIndex);

  ghost.style.pointerEvents=
    "none";

  ghost.style.willChange=
    "transform, opacity";

  ghost.style.setProperty(
    "view-transition-name",
    "none"
  );

  document.body.appendChild(
    ghost
  );

  if(
    element instanceof HTMLElement &&
    ghost instanceof HTMLElement
  ){
    ghost.scrollTop=
      element.scrollTop;

    ghost.scrollLeft=
      element.scrollLeft;

    const sourceShiftScroll=
      element.querySelector(
        ".shift-scroll"
      );

    const ghostShiftScroll=
      ghost.querySelector(
        ".shift-scroll"
      );

    if(
      sourceShiftScroll instanceof HTMLElement &&
      ghostShiftScroll instanceof HTMLElement
    ){
      ghostShiftScroll.scrollTop=
        sourceShiftScroll.scrollTop;

      ghostShiftScroll.scrollLeft=
        sourceShiftScroll.scrollLeft;
    }
  }

  return ghost;
}

function changeMonth(
  nextCursor,
  direction,
  {scrollTop=true}={}
){
  if(
    nextCursor===cursor ||
    monthTransitionRunning ||
    tabTransitionRunning
  ){
    return;
  }

  const period=
    document.getElementById(
      "period"
    );

  const apply=()=>{
    cursor=nextCursor;

    /*
      Реальную страницу переводим
      к началу нового месяца, пока
      старый экран уже удерживается
      отдельным fixed-слепком.
    */
    if(scrollTop){
      setPageScrollTop(0);
    }

    render();
  };

  if(
    prefersReducedMotion() ||
    typeof app.animate!=="function" ||
    typeof period.animate!=="function"
  ){
    apply();
    return;
  }

  monthTransitionRunning=true;

  const oldApp=
    makeMonthTransitionGhost(
      app,
      19
    );

  const oldPeriod=
    makeMonthTransitionGhost(
      period,
      21
    );

  const oldContentX=
    direction>0
      ? -28
      : 28;

  const newContentX=
    -oldContentX;

  const oldPeriodX=
    direction>0
      ? -10
      : 10;

  const newPeriodX=
    -oldPeriodX;

  /*
    Скрываем настоящие элементы до
    момента, когда в них уже будет
    отрисован новый месяц.
  */
  app.style.opacity=
    "0";

  period.style.opacity=
    "0";

  let animations=[];

  try{
    apply();

    const options={
      duration:320,
      easing:
        "cubic-bezier(.22,.72,.22,1)",
      fill:"both"
    };

    animations=[
      oldApp.animate(
        [
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          },
          {
            opacity:0,
            transform:
              `translate3d(${oldContentX}px,0,0)`
          }
        ],
        options
      ),

      app.animate(
        [
          {
            opacity:0,
            transform:
              `translate3d(${newContentX}px,0,0)`
          },
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          }
        ],
        options
      ),

      oldPeriod.animate(
        [
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          },
          {
            opacity:0,
            transform:
              `translate3d(${oldPeriodX}px,0,0)`
          }
        ],
        options
      ),

      period.animate(
        [
          {
            opacity:0,
            transform:
              `translate3d(${newPeriodX}px,0,0)`
          },
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          }
        ],
        options
      )
    ];

    app.style.removeProperty(
      "opacity"
    );

    period.style.removeProperty(
      "opacity"
    );

    Promise.allSettled(
      animations.map(
        animation=>
          animation.finished
      )
    ).finally(()=>{
      animations.forEach(
        animation=>
          animation.cancel()
      );

      oldApp.remove();
      oldPeriod.remove();

      app.style.removeProperty(
        "opacity"
      );

      period.style.removeProperty(
        "opacity"
      );

      monthTransitionRunning=false;
    });
  }catch{
    animations.forEach(
      animation=>
        animation.cancel()
    );

    oldApp.remove();
    oldPeriod.remove();

    app.style.removeProperty(
      "opacity"
    );

    period.style.removeProperty(
      "opacity"
    );

    monthTransitionRunning=false;
  }
}

function selectMonth(ym){
  const direction=
    ym>cursor
      ? 1
      : ym<cursor
        ? -1
        : 0;

  closeMonthPicker();

  if(direction===0){
    return;
  }

  changeMonth(
    ym,
    direction,
    {scrollTop:true}
  );
}

/* ========== события ========== */
document.getElementById("prevM").onclick=()=>{
  changeMonth(
    shiftMonth(cursor,-1),
    -1
  );
};

document.getElementById("nextM").onclick=()=>{
  changeMonth(
    shiftMonth(cursor,1),
    1
  );
};

document.getElementById("period").onclick=openMonthPicker;

let monthPickerYearTransitionRunning=false;
let dateJumpYearTransitionRunning=false;

function animatePickerYearChange({
  container,
  grid,
  label,
  direction,
  apply,
  onFinish
}){
  const finish=()=>{
    if(onFinish){
      onFinish();
    }
  };

  if(
    prefersReducedMotion() ||
    typeof grid.animate!=="function"
  ){
    apply();
    finish();
    return;
  }

  let oldGrid=null;
  let oldLabel=null;
  let animations=[];
  let applied=false;

  try{
    oldGrid=
      makeDateCalendarGhost(
        grid,
        container
      );

    oldLabel=
      makeDateCalendarGhost(
        label,
        container
      );

    apply();
    applied=true;

    grid.style.pointerEvents="none";

    const oldGridX=
      direction>0
        ? -28
        : 28;

    const newGridX=
      -oldGridX;

    const oldLabelX=
      direction>0
        ? -10
        : 10;

    const newLabelX=
      -oldLabelX;

    const options={
      duration:320,
      easing:
        "cubic-bezier(.22,.72,.22,1)",
      fill:"both"
    };

    animations=[
      oldGrid.animate(
        [
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          },
          {
            opacity:0,
            transform:
              `translate3d(${oldGridX}px,0,0)`
          }
        ],
        options
      ),

      grid.animate(
        [
          {
            opacity:0,
            transform:
              `translate3d(${newGridX}px,0,0)`
          },
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          }
        ],
        options
      ),

      oldLabel.animate(
        [
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          },
          {
            opacity:0,
            transform:
              `translate3d(${oldLabelX}px,0,0)`
          }
        ],
        options
      ),

      label.animate(
        [
          {
            opacity:0,
            transform:
              `translate3d(${newLabelX}px,0,0)`
          },
          {
            opacity:1,
            transform:
              "translate3d(0,0,0)"
          }
        ],
        options
      )
    ];

    Promise.allSettled(
      animations.map(
        animation=>animation.finished
      )
    ).finally(()=>{
      animations.forEach(
        animation=>animation.cancel()
      );

      oldGrid?.remove();
      oldLabel?.remove();

      grid.style.removeProperty(
        "pointer-events"
      );

      finish();
    });
  }catch{
    animations.forEach(
      animation=>animation.cancel()
    );

    oldGrid?.remove();
    oldLabel?.remove();

    grid.style.removeProperty(
      "pointer-events"
    );

    if(!applied){
      apply();
    }

    finish();
  }
}

function changeMonthPickerYear(direction){
  if(monthPickerYearTransitionRunning){
    return;
  }

  const nextYear=
    Math.min(
      MAX_YEAR,
      Math.max(
        MIN_YEAR,
        monthPickerYear+direction
      )
    );

  if(nextYear===monthPickerYear){
    return;
  }

  monthPickerYearTransitionRunning=true;

  animatePickerYearChange({
    container:
      document.getElementById(
        "monthPicker"
      ),

    grid:
      document.getElementById(
        "monthGrid"
      ),

    label:
      document.getElementById(
        "monthPickerYear"
      ),

    direction,

    apply:()=>{
      monthPickerYear=nextYear;
      drawMonthPicker();
    },

    onFinish:()=>{
      monthPickerYearTransitionRunning=false;
    }
  });
}

function changeDateJumpYear(direction){
  if(dateJumpYearTransitionRunning){
    return;
  }

  const nextYear=
    Math.min(
      MAX_YEAR,
      Math.max(
        MIN_YEAR,
        dateJumpYear+direction
      )
    );

  if(nextYear===dateJumpYear){
    return;
  }

  dateJumpYearTransitionRunning=true;

  animatePickerYearChange({
    container:
      document.getElementById(
        "dateJump"
      ),

    grid:
      document.getElementById(
        "dateJumpMonths"
      ),

    label:
      document.getElementById(
        "dateJumpYear"
      ),

    direction,

    apply:()=>{
      dateJumpYear=
        nextYear;

      drawDateJump();
    },

    onFinish:()=>{
      dateJumpYearTransitionRunning=false;
    }
  });
}

function bindYearSwipe(
  element,
  changeYear
){
  let swipe=null;

  element.addEventListener(
    "pointerdown",
    e=>{
      if(
        !e.isPrimary ||
        !["touch","pen"].includes(
          e.pointerType
        )
      ){
        return;
      }

      swipe={
        id:e.pointerId,
        x:e.clientX,
        y:e.clientY,
        time:performance.now(),
        axis:null
      };

      try{
        element.setPointerCapture(
          e.pointerId
        );
      }catch{}
    }
  );

  element.addEventListener(
    "pointermove",
    e=>{
      if(
        !swipe ||
        e.pointerId!==swipe.id
      ){
        return;
      }

      const dx=
        e.clientX-swipe.x;

      const dy=
        e.clientY-swipe.y;

      const absX=
        Math.abs(dx);

      const absY=
        Math.abs(dy);

      if(swipe.axis===null){
        if(
          absX<8 &&
          absY<8
        ){
          return;
        }

        if(
          absX>=10 &&
          absX>absY*1.10
        ){
          swipe.axis="x";
        }else if(
          absY>=14 &&
          absY>absX*1.25
        ){
          swipe.axis="y";
          return;
        }else{
          return;
        }
      }

      if(swipe.axis!=="x"){
        return;
      }

      if(e.cancelable){
        e.preventDefault();
      }
    }
  );

  const finish=e=>{
    if(
      !swipe ||
      e.pointerId!==swipe.id
    ){
      return;
    }

    const current=swipe;
    swipe=null;

    try{
      if(
        element.hasPointerCapture(
          e.pointerId
        )
      ){
        element.releasePointerCapture(
          e.pointerId
        );
      }
    }catch{}

    const dx=
      e.clientX-current.x;

    const dy=
      e.clientY-current.y;

    const absX=
      Math.abs(dx);

    const absY=
      Math.abs(dy);

    const duration=
      Math.max(
        1,
        performance.now()-current.time
      );

    const velocity=
      absX/duration;

    const horizontal=
      absX>absY*1.08;

    const enoughDistance=
      absX>=35;

    const fastSwipe=
      absX>=22 &&
      velocity>=0.30;

    if(
      current.axis!=="x" ||
      !horizontal ||
      (
        !enoughDistance &&
        !fastSwipe
      )
    ){
      return;
    }

    changeYear(
      dx<0
        ? 1
        : -1
    );
  };

  element.addEventListener(
    "pointerup",
    finish
  );

  element.addEventListener(
    "pointercancel",
    e=>{
      if(
        !swipe ||
        e.pointerId!==swipe.id
      ){
        return;
      }

      swipe=null;
    }
  );
}

bindYearSwipe(
  document.getElementById("monthGrid"),
  changeMonthPickerYear
);

bindYearSwipe(
  document.getElementById("dateJumpMonths"),
  changeDateJumpYear
);

document.getElementById("monthVeil").onclick=closeMonthPicker;

document.getElementById("monthYearPrev").onclick=()=>{
  changeMonthPickerYear(-1);
};

document.getElementById("monthYearNext").onclick=()=>{
  changeMonthPickerYear(1);
};

document.getElementById("monthGrid").onclick=e=>{
  const option=e.target.closest("[data-month]");

  if(!option) return;

  monthPickerValue=
    option.dataset.month;

  monthPickerYear=Number(
    monthPickerValue.slice(0,4)
  );

  drawMonthPicker();
};

document.getElementById("monthToday").onclick=()=>{
  if(monthPickerYearTransitionRunning){
    return;
  }

  const currentMonth=
    ymOf(new Date());

  const currentYear=
    Number(
      currentMonth.slice(0,4)
    );

  if(currentYear===monthPickerYear){
    monthPickerValue=
      currentMonth;

    drawMonthPicker();
    return;
  }

  monthPickerYearTransitionRunning=true;

  animatePickerYearChange({
    container:
      document.getElementById(
        "monthPicker"
      ),

    grid:
      document.getElementById(
        "monthGrid"
      ),

    label:
      document.getElementById(
        "monthPickerYear"
      ),

    direction:
      currentYear>monthPickerYear
        ? 1
        : -1,

    apply:()=>{
      monthPickerYear=
        currentYear;

      monthPickerValue=
        currentMonth;

      drawMonthPicker();
    },

    onFinish:()=>{
      monthPickerYearTransitionRunning=false;
    }
  });
};

document.getElementById("monthCancel").onclick=()=>{
  closeMonthPicker();
};

document.getElementById("monthDone").onclick=()=>{
  if(!monthPickerValue) return;

  selectMonth(monthPickerValue);
};

const monthPickerElement=
  document.getElementById("monthPicker");

function bindBottomSheetDismiss({
  element,
  dragProperty,
  close,
  canStart=()=>true,
  onBegin=()=>{}
}){
  let gesture=null;
  let dragFrame=0;
  let pendingDistance=0;
  let snapTimer=0;
  let suppressClickUntil=0;

  const blockedTarget=target=>
    target instanceof Element &&
    Boolean(
      target.closest(
        'input,textarea,select,[contenteditable="true"]'
      )
    );

  const queueDistance=distance=>{
    pendingDistance=distance;

    if(dragFrame){
      return;
    }

    dragFrame=requestAnimationFrame(()=>{
      dragFrame=0;

      element.style.setProperty(
        dragProperty,
        pendingDistance+"px"
      );
    });
  };

  const flushDistance=()=>{
    if(!dragFrame){
      return;
    }

    cancelAnimationFrame(dragFrame);
    dragFrame=0;

    element.style.setProperty(
      dragProperty,
      pendingDistance+"px"
    );
  };

  const beginDrag=()=>{
    clearTimeout(snapTimer);

    onBegin();

    element.style.transition="none";
  };

  const snapBack=()=>{
    element.style.transition=
      "transform .42s cubic-bezier(.4,0,.2,1)";

    requestAnimationFrame(()=>{
      element.style.setProperty(
        dragProperty,
        "0px"
      );
    });

    snapTimer=setTimeout(()=>{
      if(
        element.classList.contains("on")
      ){
        element.style.removeProperty(
          "transition"
        );

        element.style.removeProperty(
          dragProperty
        );
      }
    },440);
  };

  const animateClose=distance=>{
    const endDistance=
      element.getBoundingClientRect()
        .height+40;

    if(
      prefersReducedMotion() ||
      typeof element.animate!=="function"
    ){
      element.style.removeProperty(
        "transition"
      );

      close();
      return;
    }

    element.style.removeProperty(
      "transition"
    );

    const animation=
      element.animate(
        [
          {
            transform:
              `translate3d(0,${distance}px,0)`
          },
          {
            transform:
              `translate3d(0,${endDistance}px,0)`
          }
        ],
        {
          duration:420,
          easing:
            "cubic-bezier(.4,0,.2,1)",
          fill:"both"
        }
      );

    close();

    animation.finished
      .catch(()=>{})
      .finally(()=>{
        animation.cancel();
      });
  };

  const finishDrag=({
    allowClose=true
  }={})=>{
    if(
      !gesture ||
      gesture.axis!=="y"
    ){
      gesture=null;
      return;
    }

    flushDistance();

    const distance=
      gesture.distance;

    const duration=Math.max(
      1,
      performance.now()-
        gesture.started
    );

    const fastSwipe=
      distance>=22 &&
      distance/duration>=0.32;

    const shouldClose=
      allowClose &&
      (
        distance>=56 ||
        fastSwipe
      );

    gesture=null;

    suppressClickUntil=
      performance.now()+650;

    if(shouldClose){
      animateClose(distance);
      return;
    }

    snapBack();
  };

  const lockAxis=(
    dx,
    dy
  )=>{
    if(!gesture){
      return false;
    }

    const absX=Math.abs(dx);
    const absY=Math.abs(dy);

    if(gesture.axis!==null){
      return gesture.axis==="y";
    }

    if(
      absX<8 &&
      absY<8
    ){
      return false;
    }

    if(
      absX>=10 &&
      absX>absY*1.10
    ){
      gesture.axis="x";
      return false;
    }

    if(
      dy<0 &&
      absY>=10 &&
      absY>absX*1.10
    ){
      gesture.axis="scroll";
      return false;
    }

    if(
      dy>0 &&
      absY>=10 &&
      absY>absX*1.08
    ){
      if(!canStart(gesture.target)){
        gesture.axis="scroll";
        return false;
      }

      gesture.axis="y";
      beginDrag();
      return true;
    }

    return false;
  };

  element.addEventListener(
    "touchstart",
    event=>{
      if(
        event.touches.length!==1 ||
        !element.classList.contains("on") ||
        blockedTarget(event.target)
      ){
        gesture=null;
        return;
      }

      const touch=
        event.touches[0];

      gesture={
        kind:"touch",
        id:touch.identifier,
        target:event.target,
        startX:touch.clientX,
        startY:touch.clientY,
        distance:0,
        started:performance.now(),
        axis:null
      };
    },
    {passive:true}
  );

  element.addEventListener(
    "touchmove",
    event=>{
      if(
        !gesture ||
        gesture.kind!=="touch"
      ){
        return;
      }

      const touch=
        findTouch(
          event.touches,
          gesture.id
        );

      if(!touch){
        return;
      }

      const dx=
        touch.clientX-
        gesture.startX;

      const dy=
        touch.clientY-
        gesture.startY;

      if(!lockAxis(dx,dy)){
        return;
      }

      gesture.distance=
        Math.max(0,dy);

      queueDistance(
        gesture.distance
      );

      if(event.cancelable){
        event.preventDefault();
      }
    },
    {passive:false}
  );

  element.addEventListener(
    "touchend",
    event=>{
      if(
        !gesture ||
        gesture.kind!=="touch"
      ){
        return;
      }

      const touch=
        findTouch(
          event.changedTouches,
          gesture.id
        );

      if(
        touch &&
        gesture.axis==="y"
      ){
        gesture.distance=
          Math.max(
            0,
            touch.clientY-
              gesture.startY
          );

        pendingDistance=
          gesture.distance;
      }

      finishDrag();
    }
  );

  element.addEventListener(
    "touchcancel",
    ()=>{
      if(
        !gesture ||
        gesture.kind!=="touch"
      ){
        return;
      }

      finishDrag({
        allowClose:false
      });
    }
  );

  element.addEventListener(
    "pointerdown",
    event=>{
      if(
        event.pointerType==="touch" ||
        !event.isPrimary ||
        !element.classList.contains("on") ||
        blockedTarget(event.target)
      ){
        return;
      }

      gesture={
        kind:"pointer",
        id:event.pointerId,
        target:event.target,
        startX:event.clientX,
        startY:event.clientY,
        distance:0,
        started:performance.now(),
        axis:null
      };
    }
  );

  element.addEventListener(
    "pointermove",
    event=>{
      if(
        !gesture ||
        gesture.kind!=="pointer" ||
        event.pointerId!==gesture.id
      ){
        return;
      }

      const dx=
        event.clientX-
        gesture.startX;

      const dy=
        event.clientY-
        gesture.startY;

      const wasDragging=
        gesture.axis==="y";

      if(!lockAxis(dx,dy)){
        return;
      }

      if(!wasDragging){
        try{
          element.setPointerCapture(
            event.pointerId
          );
        }catch{}
      }

      gesture.distance=
        Math.max(0,dy);

      queueDistance(
        gesture.distance
      );

      event.preventDefault();
    }
  );

  element.addEventListener(
    "pointerup",
    event=>{
      if(
        !gesture ||
        gesture.kind!=="pointer" ||
        event.pointerId!==gesture.id
      ){
        return;
      }

      if(gesture.axis==="y"){
        gesture.distance=
          Math.max(
            0,
            event.clientY-
              gesture.startY
          );

        pendingDistance=
          gesture.distance;
      }

      try{
        if(
          element.hasPointerCapture(
            event.pointerId
          )
        ){
          element.releasePointerCapture(
            event.pointerId
          );
        }
      }catch{}

      finishDrag();
    }
  );

  element.addEventListener(
    "pointercancel",
    event=>{
      if(
        !gesture ||
        gesture.kind!=="pointer" ||
        event.pointerId!==gesture.id
      ){
        return;
      }

      finishDrag({
        allowClose:false
      });
    }
  );

  element.addEventListener(
    "click",
    event=>{
      if(
        performance.now()>
        suppressClickUntil
      ){
        return;
      }

      suppressClickUntil=0;

      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
}

bindBottomSheetDismiss({
  element:monthPickerElement,
  dragProperty:"--month-drag",
  close:closeMonthPicker
});

let monthSwipe=null;
let suppressMonthClick=false;

const monthSwipeArea=document;

function resetMonthSwipe(){
  monthSwipe=null;
  document.body.classList.remove("month-swiping");
}

function findTouch(list,id){
  for(let i=0;i<list.length;i++){
    const touch=list[i];

    if(touch.identifier===id){
      return touch;
    }
  }

  return null;
}

function monthSwipeStartBlocked(target){
  if(!(target instanceof Element)){
    return true;
  }

  return Boolean(
    target.closest(
      "input,textarea,select,a,button:not(.sh)"
    )
  );
}

monthSwipeArea.addEventListener(
  "touchstart",
  e=>{
    if(
      !["shifts","stats"].includes(tab) ||
      monthTransitionRunning ||
      e.touches.length!==1 ||
      document.body.classList.contains("sheet-open") ||
      document.body.classList.contains("point-picker-open") ||
      document.body.classList.contains("month-picker-open") ||
      monthSwipeStartBlocked(e.target)
    ){
      resetMonthSwipe();
      return;
    }

    const touch=e.touches[0];

    monthSwipe={
      id:touch.identifier,
      x:touch.clientX,
      y:touch.clientY,
      lastX:touch.clientX,
      lastY:touch.clientY,
      time:performance.now(),
      axis:null
    };
  },
  {passive:true}
);

monthSwipeArea.addEventListener(
  "touchmove",
  e=>{
    if(!monthSwipe){
      return;
    }

    const touch=
      findTouch(
        e.touches,
        monthSwipe.id
      );

    if(!touch){
      return;
    }

    monthSwipe.lastX=
      touch.clientX;

    monthSwipe.lastY=
      touch.clientY;

    const dx=
      touch.clientX-monthSwipe.x;

    const dy=
      touch.clientY-monthSwipe.y;

    const absX=
      Math.abs(dx);

    const absY=
      Math.abs(dy);

    /*
      Не определяем направление по первым
      2–6 пикселям движения пальца.

      Это специально оставляет небольшой
      dead zone для естественного дрожания
      пальца на iPhone.
    */
    if(monthSwipe.axis===null){
      if(
        absX<8 &&
        absY<8
      ){
        return;
      }

      /*
        Горизонтальный жест определяем
        немного охотнее вертикального.
      */
      if(
        absX>=10 &&
        absX>absY*1.10
      ){
        monthSwipe.axis="x";
      }

      /*
        Вертикальный scroll блокируем
        только когда вертикальное намерение
        уже достаточно очевидно.
      */
      else if(
        absY>=14 &&
        absY>absX*1.25
      ){
        monthSwipe.axis="y";
      }

      else{
        return;
      }
    }

    if(monthSwipe.axis==="x"){
      document.body.classList.add(
        "month-swiping"
      );

      /*
        Только после уверенного определения
        горизонтального свайпа забираем
        жест у Safari.
      */
      if(e.cancelable){
        e.preventDefault();
      }
    }
  },
  {passive:false}
);

function finishMonthSwipe(e){
  if(!monthSwipe){
    return;
  }

  const swipe=monthSwipe;

  const touch=
    findTouch(
      e.changedTouches,
      swipe.id
    );

  const endX=
    touch
      ? touch.clientX
      : swipe.lastX;

  const endY=
    touch
      ? touch.clientY
      : swipe.lastY;

  const dx=
    endX-swipe.x;

  const dy=
    endY-swipe.y;

  const absX=
    Math.abs(dx);

  const absY=
    Math.abs(dy);

  const duration=
    Math.max(
      1,
      performance.now()-swipe.time
    );

  const velocity=
    absX/duration;

  resetMonthSwipe();

  /*
    Финальная страховка от вертикального
    скролла и диагонального жеста.
  */
  const horizontal=
    absX>absY*1.08;

  /*
    Обычный осознанный свайп.
  */
  const enoughDistance=
    absX>=38;

  /*
    Или короткий, но быстрый flick.
  */
  const fastSwipe=
    absX>=22 &&
    velocity>=0.30;

  if(
    swipe.axis==="y" ||
    !horizontal ||
    (
      !enoughDistance &&
      !fastSwipe
    )
  ){
    return;
  }

  const nextCursor=
    shiftMonth(
      cursor,
      dx<0 ? 1 : -1
    );

  if(nextCursor===cursor){
    return;
  }

  /*
    Не даём iOS после свайпа открыть
    случайно ту смену, на которой
    закончился палец.
  */
  suppressMonthClick=true;

  changeMonth(
    nextCursor,
    dx<0 ? 1 : -1,
    {scrollTop:true}
  );

  setTimeout(()=>{
    suppressMonthClick=false;
  },400);
}

monthSwipeArea.addEventListener(
  "touchend",
  finishMonthSwipe,
  {passive:true}
);

monthSwipeArea.addEventListener(
  "touchcancel",
  resetMonthSwipe,
  {passive:true}
);

let pointerPressGuard=null;
let suppressMovedPointerClickUntil=0;

document.addEventListener(
  "pointerdown",
  e=>{
    if(
      !e.isPrimary ||
      !["touch","pen"].includes(e.pointerType)
    ){
      return;
    }

    /*
      Поля ввода оставляем полностью
      нативными: курсор, выделение,
      перемещение пальца и т. д.
    */
    if(
      e.target instanceof Element &&
      e.target.closest(
        "input,textarea,select,[contenteditable='true']"
      )
    ){
      pointerPressGuard=null;
      suppressMovedPointerClickUntil=0;
      return;
    }

    /*
      Новый настоящий тап всегда очищает
      старую страховку.
    */
    suppressMovedPointerClickUntil=0;

    pointerPressGuard={
      id:e.pointerId,
      x:e.clientX,
      y:e.clientY,
      moved:false
    };
  },
  true
);

document.addEventListener(
  "pointermove",
  e=>{
    if(
      !pointerPressGuard ||
      e.pointerId!==pointerPressGuard.id
    ){
      return;
    }

    const dx=
      e.clientX-pointerPressGuard.x;

    const dy=
      e.clientY-pointerPressGuard.y;

    if(
      Math.hypot(dx,dy)>=8
    ){
      pointerPressGuard.moved=true;
    }
  },
  true
);

document.addEventListener(
  "pointerup",
  e=>{
    if(
      !pointerPressGuard ||
      e.pointerId!==pointerPressGuard.id
    ){
      return;
    }

    const moved=
      pointerPressGuard.moved;

    pointerPressGuard=null;

    if(moved){
      suppressMovedPointerClickUntil=
        performance.now()+650;
    }
  },
  true
);

document.addEventListener(
  "pointercancel",
  e=>{
    if(
      !pointerPressGuard ||
      e.pointerId!==pointerPressGuard.id
    ){
      return;
    }

    pointerPressGuard=null;

    suppressMovedPointerClickUntil=
      performance.now()+650;
  },
  true
);

document.addEventListener(
  "click",
  e=>{
    const movedPointerClick=
      e.detail!==0 &&
      performance.now()<=
        suppressMovedPointerClickUntil;

    if(
      !suppressMonthClick &&
      !movedPointerClick
    ){
      return;
    }

    suppressMovedPointerClickUntil=0;

    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true
);

const TAB_ORDER=[
  "shifts",
  "stats",
  "data"
];

function changeTab(
  nextTab,
  {
    direction=null,
    focus=false
  }={}
){
  if(
    !TAB_ORDER.includes(nextTab)
  ){
    return;
  }

  if(nextTab===tab){
    setPageScrollTop(0);

    if(focus){
      document
        .getElementById(
          "tab-"+nextTab
        )
        ?.focus();
    }

    return;
  }

  if(
    tabTransitionRunning ||
    monthTransitionRunning
  ){
    return;
  }

  const currentIndex=
    TAB_ORDER.indexOf(tab);

  const nextIndex=
    TAB_ORDER.indexOf(nextTab);

  const resolvedDirection=
    direction ??
    (
      nextIndex>currentIndex
        ? 1
        : -1
    );

  const apply=()=>{
    tab=nextTab;
    setPageScrollTop(0);
    render();
  };

  const finish=()=>{
    if(focus){
      document
        .getElementById(
          "tab-"+nextTab
        )
        ?.focus();
    }
  };

  if(
    prefersReducedMotion() ||
    typeof app.animate!=="function"
  ){
    apply();
    finish();
    return;
  }

  tabTransitionRunning=true;

  apply();

  const startX=
    resolvedDirection>0
      ? 24
      : -24;

  app.style.left=
    `${startX}px`;

  void app.offsetWidth;

  let animation;

  try{
    animation=app.animate(
      [
        {
          left:
            `${startX}px`
        },
        {
          left:"0px"
        }
      ],
      {
        duration:250,
        easing:
          "cubic-bezier(.22,.72,.22,1)",
        fill:"both"
      }
    );

    app.style.left="0px";
  }catch{
    app.style.removeProperty(
      "left"
    );

    tabTransitionRunning=false;

    finish();
    return;
  }

  animation.finished
    .catch(()=>{})
    .finally(()=>{
      animation.cancel();

      app.style.removeProperty(
        "left"
      );

      tabTransitionRunning=false;

      finish();
    });
}

TAB_ORDER.forEach(name=>{
  const button=
    document.getElementById(
      "tab-"+name
    );

  button.onclick=()=>{
    changeTab(name);
  };

  button.addEventListener(
    "keydown",
    e=>{
      if(
        ![
          "ArrowLeft",
          "ArrowRight"
        ].includes(e.key)
      ){
        return;
      }

      e.preventDefault();

      const current=
        TAB_ORDER.indexOf(tab);

      const direction=
        e.key==="ArrowRight"
          ? 1
          : -1;

      const next=
        TAB_ORDER[
          (
            current+
            direction+
            TAB_ORDER.length
          )%
          TAB_ORDER.length
        ];

      changeTab(
        next,
        {
          direction,
          focus:true
        }
      );
    }
  );
});

document.getElementById("fab").onclick=()=>openSheet(null);
document.getElementById("veil").onclick=closeSheet;
document.getElementById("sheetCancel").onclick=closeSheet;
document.getElementById("pointVeil").onclick=closePointPicker;
document.getElementById("dateVeil").onclick=closeDatePicker;

document.getElementById("datePrev").onclick=()=>{
  changeDateCalendarMonth(
    shiftMonth(
      dateCalendarCursor,
      -1
    ),
    -1
  );
};

document.getElementById("dateNext").onclick=()=>{
  changeDateCalendarMonth(
    shiftMonth(
      dateCalendarCursor,
      1
    ),
    1
  );
};

document.getElementById("datePickerMonth").onclick=()=>{
  toggleDateJump();
};

document.getElementById("dateJumpPrevYear").onclick=()=>{
  changeDateJumpYear(-1);
};

document.getElementById("dateJumpNextYear").onclick=()=>{
  changeDateJumpYear(1);
};

const dateJumpCancelButton=
  document.getElementById(
    "dateJumpCancel"
  );

if(dateJumpCancelButton){
  dateJumpCancelButton.onclick=()=>{
    closeDateJump();
  };
}

const dateJumpDoneButton=
  document.getElementById(
    "dateJumpDone"
  );

if(dateJumpDoneButton){
  dateJumpDoneButton.onclick=()=>{
    if(!dateJumpValue){
      return;
    }

    const nextCursor=
      dateJumpValue;

    const direction=
      nextCursor>dateCalendarCursor
        ? 1
        : nextCursor<dateCalendarCursor
          ? -1
          : 0;

    closeDateJump();

    if(direction===0){
      return;
    }

    changeDateCalendarMonth(
      nextCursor,
      direction
    );
  };
}

document.getElementById("dateJumpCurrent")?.addEventListener("click",()=>{
  if(dateJumpYearTransitionRunning){
    return;
  }

  const currentMonth=
    ymOf(new Date());

  const currentYear=
    Number(
      currentMonth.slice(0,4)
    );

  if(currentYear===dateJumpYear){
    dateJumpValue=
      currentMonth;

    drawDateJump();
    return;
  }

  dateJumpYearTransitionRunning=true;

  animatePickerYearChange({
    container:
      document.getElementById(
        "dateJump"
      ),

    grid:
      document.getElementById(
        "dateJumpMonths"
      ),

    label:
      document.getElementById(
        "dateJumpYear"
      ),

    direction:
      currentYear>dateJumpYear
        ? 1
        : -1,

    apply:()=>{
      dateJumpYear=
        currentYear;

      dateJumpValue=
        currentMonth;

      drawDateJump();
    },

    onFinish:()=>{
      dateJumpYearTransitionRunning=false;
    }
  });
});

document.getElementById("dateJumpMonths").onclick=e=>{
  const month=
    e.target.closest(
      "[data-calendar-month]"
    );

  if(!month){
    return;
  }

  dateJumpValue=
    month.dataset.calendarMonth;

  dateJumpYear=
    Number(
      dateJumpValue.slice(0,4)
    );

  drawDateJump();
};

const datePickerElement=
  document.getElementById("datePicker");

bindBottomSheetDismiss({
  element:datePickerElement,
  dragProperty:"--date-drag",
  close:closeDatePicker,
  onBegin:closeDateJump
});

const dateGrid=document.getElementById("dateGrid");

dateGrid.onclick=e=>{
  if(dateSwipeBlockClick) return;

  const day=
    e.target.closest(
      "[data-date]"
    );

  if(!day) return;

  const value=
    day.dataset.date;

  const nextCursor=
    value.slice(0,7);

  closeDateJump();

  if(
    nextCursor!==
    dateCalendarCursor
  ){
    changeDateCalendarMonth(
      nextCursor,
      nextCursor>dateCalendarCursor
        ? 1
        : -1,
      {value}
    );

    return;
  }

  datePickerValue=value;

  drawDatePicker();
};

dateGrid.addEventListener("pointerdown",e=>{
  if(
    !e.isPrimary ||
    e.pointerType==="mouse"
  ){
    return;
  }

  dateGrid.classList.remove("date-swiping");

  dateSwipe={
    id:e.pointerId,
    x:e.clientX,
    y:e.clientY
  };

  dateSwipeBlockClick=false;
  dateGrid.setPointerCapture(e.pointerId);
});

dateGrid.addEventListener("pointermove",e=>{
  if(!dateSwipe || e.pointerId!==dateSwipe.id) return;

  const dx=e.clientX-dateSwipe.x;
  const dy=e.clientY-dateSwipe.y;

  if(Math.abs(dx)>8 && Math.abs(dx)>Math.abs(dy)){
    dateSwipeBlockClick=true;
    dateGrid.classList.add("date-swiping");
    e.preventDefault();
  }
});

function finishDateSwipe(e){
  if(!dateSwipe || e.pointerId!==dateSwipe.id) return;

  const dx=e.clientX-dateSwipe.x;
  const dy=e.clientY-dateSwipe.y;

  if(dateGrid.hasPointerCapture(e.pointerId)){
    dateGrid.releasePointerCapture(e.pointerId);
  }

  dateSwipe=null;
  dateGrid.classList.remove("date-swiping");

  const accepted=
    Math.abs(dx)>=35 &&
    Math.abs(dx)>Math.abs(dy)*1.15;

  if(accepted){
    const direction=
      dx<0
        ? 1
        : -1;

    const nextCursor=
      shiftMonth(
        dateCalendarCursor,
        direction
      );

    closeDateJump();

    changeDateCalendarMonth(
      nextCursor,
      direction
    );

    dateSwipeBlockClick=true;
  }

  setTimeout(()=>{
    dateSwipeBlockClick=false;
  },250);
}

dateGrid.addEventListener("pointerup",finishDateSwipe);

dateGrid.addEventListener("pointercancel",e=>{
  dateSwipe=null;
  dateGrid.classList.remove("date-swiping");

  setTimeout(()=>{
    dateSwipeBlockClick=false;
  },250);
});

document.getElementById("dateToday").onclick=()=>{
  const value=
    localYMD();

  const nextCursor=
    value.slice(0,7);

  closeDateJump();

  if(
    nextCursor!==
    dateCalendarCursor
  ){
    changeDateCalendarMonth(
      nextCursor,
      nextCursor>dateCalendarCursor
        ? 1
        : -1,
      {value}
    );

    return;
  }

  datePickerValue=value;

  drawDatePicker();
};

document.getElementById("dateCancel").onclick=()=>{
  closeDatePicker();
};

document.getElementById("dateDone").onclick=()=>{
  if(!datePickerValue) return;

  selectDate(datePickerValue);
};

const shiftSheet=
  document.getElementById("sheet");

bindBottomSheetDismiss({
  element:shiftSheet,
  dragProperty:"--sheet-drag",
  close:closeSheet,

  canStart:target=>{
    if(
      target instanceof Element &&
      target.closest(".grab,.shead")
    ){
      return true;
    }

    return shiftSheet.scrollTop<=0;
  }
});

const pointPicker=
  document.getElementById("pointPicker");

bindBottomSheetDismiss({
  element:pointPicker,
  dragProperty:"--point-drag",
  close:closePointPicker,

  canStart:target=>{
    if(!(target instanceof Element)){
      return true;
    }

    const list=
      target.closest(".point-list");

    return (
      !list ||
      list.scrollTop<=0
    );
  }
});

document.getElementById("sheetSave").onclick=async()=>{
  const button=document.getElementById("sheetSave");

  readForm();

  const error=validateDraft(draft);

  if(error){
    showValidationError(error);
    return;
  }

  const savedDraft=normalizedDraft(draft);
  const index=shifts.findIndex(item=>item.id===savedDraft.id);
  const nextShifts=[...shifts];

  if(index>=0){
    nextShifts[index]=savedDraft;
  }else{
    nextShifts.push(savedDraft);
  }

  button.disabled=true;
  const saved=await save(nextShifts);
  button.disabled=false;

  if(!saved) return;

  shifts=nextShifts;
  cursor=savedDraft.date.slice(0,7);

  closeSheet();
  render();
  toast("Смена сохранена");
};

document.getElementById("sheetBody").addEventListener("click",async e=>{
  const t=e.target.closest("button");

  if(!t || !draft) return;

  const isEdit=shifts.some(x=>x.id===draft.id);

  if(t.id==="f-date-open"){
    openDatePicker();
    return;
  }

  if(t.id==="f-point-open"){
    readForm();
    openPointPicker();
    return;
  }

  if(t.dataset.type){
    readForm();
    draft.type=t.dataset.type;
    drawSheet(isEdit);
    saveUIState();
  }

  else if(t.dataset.part){
    readForm();

    const nextPartial=
      t.dataset.part==="1";

    if(nextPartial && !draft.partial){
      draft.hours="";
    }

    draft.partial=nextPartial;
    drawSheet(isEdit);
    saveUIState();
  }

  else if(t.id==="f-del"){
    const confirmed=await appConfirm(
      "Удалить эту смену?",
      {
        okText:"Удалить",
        danger:true
      }
    );

    if(!confirmed) return;

    const nextShifts=
      shifts.filter(item=>item.id!==draft.id);

    if(!await save(nextShifts)) return;

    shifts=nextShifts;
    closeSheet();
    render();
    toast("Смена удалена");
  }
});

document
  .getElementById("pointList")
  .addEventListener(
    "click",
    e=>{
      const option=
        e.target.closest("[data-point]");

      if(!option || !draft){
        return;
      }

      pointPickerValue=
        option.dataset.point;

      document
        .querySelectorAll(
          "#pointList .point-option"
        )
        .forEach(button=>{
          const selected=
            button.dataset.point===
            pointPickerValue;

          button.classList.toggle(
            "on",
            selected
          );

          const check=
            button.querySelector(
              ".point-check"
            );

          if(check){
            check.textContent=
              selected ? "✓" : "";
          }
        });
    }
  );

document
  .getElementById("pointCancel")
  .onclick=()=>{
    closePointPicker();
  };

document
  .getElementById("pointDone")
  .onclick=()=>{
    if(
      !draft ||
      !pointPickerValue
    ){
      return;
    }

    const wasFixed=
      FIXED_POINTS.has(draft.point);

    readForm();

    draft.point=
      pointPickerValue;

    delete draft.pointId;

    const nowFixed=
      FIXED_POINTS.has(draft.point);

    if(nowFixed){
      draft.shk=0;
    }else if(wasFixed){
      draft.shk="";
    }

    closePointPicker();

    const isEdit=
      shifts.some(
        x=>x.id===draft.id
      );

    drawSheet(isEdit);
    saveUIState();
  };

document.getElementById("sheetBody").addEventListener("input",e=>{
  if(e.target.id==="f-hours"){
    let value=
      e.target.value
        .replace(/\./g,",")
        .replace(/[^\d,]/g,"");

    const commaIndex=
      value.indexOf(",");

    if(commaIndex>=0){
      value=
        value.slice(
          0,
          commaIndex+1
        )+
        value
          .slice(
            commaIndex+1
          )
          .replace(/,/g,"")
          .slice(0,1);
    }

    e.target.value=value;
  }

  if(
    ["f-bonus","f-fine"]
      .includes(e.target.id)
  ){
    let value=
      e.target.value
        .replace(/\./g,",")
        .replace(/[^\d,]/g,"");

    const commaIndex=
      value.indexOf(",");

    if(commaIndex>=0){
      value=
        value.slice(
          0,
          commaIndex+1
        )+
        value
          .slice(
            commaIndex+1
          )
          .replace(/,/g,"")
          .slice(0,2);
    }

    e.target.value=value;
  }

  if(
    [
      "f-shk",
      "f-hours",
      "f-bonus",
      "f-fine"
    ].includes(e.target.id)
  ){
    readForm();

    const box=
      document.getElementById(
        "calcBox"
      );

    if(box){
      box.innerHTML=
        calcHTML();
    }

    saveUIState();
  }
});

function moveFieldCaretToEnd(field){
  const allowed=[
    "f-shk",
    "f-hours",
    "f-bonus",
    "f-fine"
  ];

  if(
    !field ||
    !allowed.includes(field.id) ||
    field.value===""
  ){
    return;
  }

  setTimeout(()=>{
    if(document.activeElement!==field) return;

    const value=field.value;

    try{
      field.setSelectionRange(
        value.length,
        value.length
      );
    }catch{
      /*
        Для input type="number" iPhone
        не всегда разрешает setSelectionRange.
        Повторная установка значения
        переносит курсор в конец.
      */
      field.value="";
      field.value=value;
    }
  },0);
}

const sheetBody=
  document.getElementById("sheetBody");

sheetBody.addEventListener("focusin",e=>{
  moveFieldCaretToEnd(e.target);
});

sheetBody.addEventListener("click",e=>{
  moveFieldCaretToEnd(e.target);
});

app.addEventListener("click",async event=>{
  const row=event.target.closest("[data-edit]");
  if(row){
    openSheet(row.dataset.edit);
    return;
  }

  const button=event.target.closest("button");
  if(!button) return;

  if(button.id==="emptyAdd"){
    openSheet(null);
    return;
  }

  if(button.id==="doExport"){
    downloadText(exportEnvelopeJson(),backupFilename());
    toast("Резервная копия скачана");
    return;
  }

  if(button.id==="doCopyJson"){
    const copied=await copyText(exportEnvelopeJson());
    toast(copied ? "JSON скопирован" : "Не удалось скопировать JSON");
    return;
  }

  if(button.id==="doRawExport"){
    const raw=(loadError instanceof StorageCorruptError && loadError.raw)
      ? loadError.raw
      : store.getCurrentRaw();

    if(!raw){
      toast("Исходные данные отсутствуют");
      return;
    }

    downloadText(raw,`shift-register-raw-${localYMD()}.json`);
    toast("Исходные данные скачаны");
    return;
  }

  if(button.id==="doReloadData"){
    try{
      await loadFromStorage({notify:true});
      render();
    }catch(error){
      loadError=error;
      storageOk=false;
      render();
    }
    return;
  }

  if(button.id==="doRestoreBackup"){
    const confirmed=await appConfirm(
      loadError
        ? "Восстановить последнюю исправную копию данных?"
        : "Восстановить предыдущую версию?",
      {
        okText:"Восстановить",
        detail:loadError
          ? ""
          : "Текущая версия будет сохранена отдельно."
      }
    );
    if(!confirmed) return;

    try{
      const result=await store.restoreBackup();
      shifts=result.shifts;
      storageRevision=result.revision;
      hasBackup=result.hasBackup;
      loadError=null;
      storageOk=true;
      syncConflict=false;
      announceRevision(storageRevision);
      render();
      toast("Данные восстановлены");
    }catch(error){
      toast(error instanceof Error ? error.message : "Не удалось восстановить данные",4000);
    }
    return;
  }

  if(button.id==="doImportToggle"){
    const panel=document.getElementById("dataImportPanel");
    if(!panel) return;

    panel.hidden=!panel.hidden;

    if(!panel.hidden){
      requestAnimationFrame(()=>{
        document.getElementById("dataImportInput")?.focus();
      });
    }

    return;
  }

  if(button.id==="doImport"){
    const input=document.getElementById("dataImportInput");
    const json=input?.value.trim() || "";
    if(!json){
      toast("Вставьте резервную копию JSON",3000);
      return;
    }

    let imported;
    try{
      imported=parseBackupJson(json).shifts;
    }catch(error){
      toast(error instanceof Error ? error.message : "Некорректная резервная копия",4400);
      return;
    }

    const confirmed=await appConfirm(
      loadError
        ? "Заменить повреждённые данные?"
        : (shifts.length
            ? "Заменить все текущие смены?"
            : "Загрузить резервную копию?"),
      {
        okText:loadError || shifts.length ? "Заменить" : "Загрузить",
        detail:`Резервная копия содержит ${shiftsAccWord(imported.length)}.`
      }
    );
    if(!confirmed) return;

    if(loadError){
      try{
        const result=await store.replaceCorrupt(imported);
        shifts=result.shifts;
        storageRevision=result.revision;
        hasBackup=result.hasBackup;
        loadError=null;
        storageOk=true;
        syncConflict=false;
        announceRevision(storageRevision);
      }catch(error){
        toast(error instanceof Error ? error.message : "Не удалось заменить данные",4200);
        return;
      }
    }else{
      if(!await save(imported)) return;
      shifts=imported;
    }

    input.value="";
    render();
    toast("Загружено: "+shiftsWord(shifts.length));
    return;
  }

  if(button.id==="doWipe"){
    const confirmed=await appConfirm(
      "Удалить все смены?",
      {
        okText:"Удалить всё",
        danger:true,
        detail:"Предыдущую версию можно будет восстановить."
      }
    );
    if(!confirmed) return;

    const nextShifts=[];
    if(!await save(nextShifts)) return;
    shifts=nextShifts;
    render();
    toast("Все смены удалены");
    return;
  }
});

let scrollTimer;
document.getElementById("app").addEventListener("scroll",()=>{
  clearTimeout(scrollTimer);
  scrollTimer=setTimeout(saveUIState,150);
},{
  passive:true,
  capture:true
});

let sheetScrollTimer;
document.getElementById("sheet").addEventListener("scroll",()=>{
  clearTimeout(sheetScrollTimer);
  sheetScrollTimer=setTimeout(saveUIState,150);
},{passive:true});

window.addEventListener("pagehide",saveUIState);
document.addEventListener("freeze",saveUIState);

window.addEventListener("pageshow",()=>{
  const ui=loadUIState();

  setPageScrollTop(
    ui.scrollY || 0
  );
});

if("serviceWorker" in navigator){
  window.addEventListener("load",async()=>{
    try{
      const registration=
        await navigator.serviceWorker.register(
          "./sw.js",
          {
            updateViaCache:"none"
          }
        );

      /*
        Проверяем только сам service worker.
        CSS/JS при обычном открытии всё равно
        берутся network-first.
      */
      await registration.update();
    }catch(error){
      console.error(
        "Service worker не зарегистрирован:",
        error
      );
    }
  });

  document.addEventListener(
    "visibilitychange",
    async()=>{
      if(
        document.visibilityState!=="visible"
      ){
        saveUIState();
        return;
      }

      try{
        const registration=
          await navigator.serviceWorker
            .getRegistration();

        await registration?.update();
      }catch(error){
        console.error(
          "Не удалось проверить service worker:",
          error
        );
      }
    }
  );
}

let touchActiveState=null;
let touchActiveReleaseTimer=null;

function clearTouchActive(){
  if(touchActiveState){
    clearTimeout(touchActiveState.timer);

    touchActiveState.element.classList.remove(
      "touch-active"
    );

    touchActiveState=null;
  }

  clearTimeout(touchActiveReleaseTimer);
  touchActiveReleaseTimer=null;

  document
    .querySelectorAll(".touch-active")
    .forEach(element=>{
      element.classList.remove("touch-active");
    });
}

document.addEventListener("pointerdown",e=>{
  if(
    !e.isPrimary ||
    e.pointerType==="mouse"
  ){
    return;
  }

  const element=e.target.closest(
    "button:not(:disabled)," +
    ".period.clickable," +
    ".sh"
  );

  if(!element) return;

  clearTouchActive();

  const state={
    id:e.pointerId,
    element,
    x:e.clientX,
    y:e.clientY,
    timer:null
  };

  state.timer=setTimeout(()=>{
    if(touchActiveState===state){
      element.classList.add("touch-active");
    }
  },80);

  touchActiveState=state;
});

document.addEventListener("pointermove",e=>{
  const state=touchActiveState;

  if(
    !state ||
    e.pointerId!==state.id
  ){
    return;
  }

  const dx=e.clientX-state.x;
  const dy=e.clientY-state.y;

  if(Math.hypot(dx,dy)<8) return;

  clearTouchActive();
});

document.addEventListener("pointerup",e=>{
  const state=touchActiveState;

  if(
    !state ||
    e.pointerId!==state.id
  ){
    return;
  }

  clearTimeout(state.timer);
  touchActiveState=null;

  const dx=e.clientX-state.x;
  const dy=e.clientY-state.y;

  if(Math.hypot(dx,dy)>=8){
    state.element.classList.remove(
      "touch-active"
    );

    return;
  }

  state.element.classList.add("touch-active");

  clearTimeout(touchActiveReleaseTimer);

  touchActiveReleaseTimer=setTimeout(()=>{
    state.element.classList.remove(
      "touch-active"
    );

    touchActiveReleaseTimer=null;
  },110);
});

document.addEventListener("pointercancel",e=>{
  if(
    !touchActiveState ||
    e.pointerId!==touchActiveState.id
  ){
    return;
  }

  clearTouchActive();
});

document.addEventListener(
  "scroll",
  clearTouchActive,
  true
);

window.addEventListener(
  "blur",
  clearTouchActive
);

load();
