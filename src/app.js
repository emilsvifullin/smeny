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
      scrollY:window.scrollY,
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

function money(number){return nf(number)+"\u00A0₽";}
function esc(value){
  return String(value??"").replace(/[&<>\"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));
}

function hoursWord(hours){
  const n=Math.floor(hours),last=n%10,lastTwo=n%100;
  if(hours!==n) return hours+" ч";
  if(last===1 && lastTwo!==11) return n+" час";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" часа";
  return n+" часов";
}

function shiftsWord(n){
  const last=n%10,lastTwo=n%100;
  if(last===1 && lastTwo!==11) return n+" смена";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" смены";
  return n+" смен";
}

function partialShortWord(n){
  const last=n%10,lastTwo=n%100;
  if(last===1 && lastTwo!==11) return n+" неполная";
  if(last>=2 && last<=4 && (lastTwo<10 || lastTwo>=20)) return n+" неполные";
  return n+" неполных";
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

function appConfirm(message,{okText="Подтвердить",danger=false}={}){
  const modal=document.getElementById("appConfirm");
  const text=document.getElementById("appConfirmText");
  const ok=document.getElementById("appConfirmOk");
  const cancel=document.getElementById("appConfirmCancel");

  appConfirmPreviousFocus=document.activeElement;
  text.textContent=message;
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

  const savedDraft=pendingUI.draft;
  if(!loadError && pendingUI.sheetOpen===true && isRecoverableDraft(savedDraft)){
    openSheet(savedDraft.id,savedDraft,pendingUI.sheetScrollTop || 0);
  }

  requestAnimationFrame(()=>window.scrollTo(0,pendingUI.scrollY || 0));
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

  const showFab=tab==="shifts" && inMonth(cursor).length>0 && !loadError;
  document.getElementById("fab").classList.toggle("is-hidden",!showFab);

  ["shifts","stats","data"].forEach(name=>{
    const button=document.getElementById("tab-"+name);
    const selected=name===tab;
    button.classList.toggle("on",selected);
    button.setAttribute("aria-selected",String(selected));
    button.tabIndex=selected ? 0 : -1;
  });

  app.innerHTML=
    tab==="shifts"
      ? viewShifts()
      : tab==="stats"
        ? viewStats()
        : viewData();
}

function viewShifts(){
  const list=inMonth(cursor);
  if(!list.length){
    return `
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

  let html=`<div class="ml">${shiftsWord(list.length)}</div><div class="card">`;

  for(const shift of list){
    const result=calc(shift);
    const parts=shift.date.split("-");
    const tags=[];
    if(shift.type==="extra") tags.push(`<span class="tag g">Доп</span>`);
    if(shift.partial) tags.push(`<span class="tag">${hoursWord(result.hours)}</span>`);
    if(result.bonus>0) tags.push(`<span class="tag g">+${nf(result.bonus)}</span>`);
    if(result.fine>0) tags.push(`<span class="tag r">−${nf(result.fine)}</span>`);
    const shkLabel=result.fixed ? "Оклад" : `${shift.shk==="" ? "—" : nf(shift.shk)} ШК`;

    html+=`
      <button type="button" class="sh" data-edit="${esc(shift.id)}" aria-label="${esc(dateLabel(shift.date))}, ${esc(shift.point)}, ${money(result.total)}">
        <span class="day"><span class="d">${Number(parts[2])}</span><span class="w">${WD[new Date(shift.date+"T12:00:00").getDay()]}</span></span>
        <span class="mid">
          <span class="p">${esc(shift.point)}</span>
          <span class="meta">
            <span>${shkLabel} · ${nf(result.rate)} ₽</span>
            ${tags.join("")}
          </span>
        </span>
        <span class="amt">${money(result.total)}</span>
      </button>`;
  }

  return html+`</div>`;
}

function viewStats(){
  const payout=payouts(cursor);
  const aggregate=payout.all;
  const details=[];

  if(aggregate.extra) details.push(aggregate.extra+" доп.");
  if(aggregate.part) details.push(partialShortWord(aggregate.part));

  const summaryParts=[shiftsWord(aggregate.n)];
  if(details.length) summaryParts.push("из них "+details.join(" и "));
  summaryParts.push(nf(aggregate.shk)+" ШК");
  const shiftsSummary=summaryParts.join(" · ");

  const futureNote=payout.futureCount
    ? `<div class="note future-note">${shiftsWord(payout.futureCount)} с будущей датой пока не входят в начисления.</div>`
    : "";

  let html=`
    <div class="card">
      <div class="hero">
        <div class="k">Начислено за ${esc(monthNom(cursor))}</div>
        <div class="n">${nf(aggregate.total)}<small> ₽</small></div>
        <div class="sub">${shiftsSummary}</div>
      </div>

      <div class="prog">
        <div class="top">
          <span>Начислено к авансу · 25 ${esc(monthGen(cursor))}</span>
          <span>${money(payout.accruedBy25)}</span>
        </div>

        <div class="limit">
          <div class="limit-row"><span>В аванс</span><span class="limit-value">${money(payout.advance)}</span></div>
          <div class="limit-row"><span>Перенесено в окончательный расчёт</span><span class="limit-value">${money(payout.carryToFinal)}</span></div>
        </div>

        <progress class="advance-progress" max="${ADVANCE_CAP}" value="${Math.max(0,payout.advance)}" aria-label="Прогресс аванса"></progress>
      </div>
    </div>
    ${futureNote}
  `;

  html+=`
    <div class="ml">Выплаты</div>
    <div class="card">
      <div class="row">
        <div class="l"><div class="t">Аванс · 25 ${esc(monthGen(cursor))}</div><div class="s">максимальная выплата — ${money(ADVANCE_CAP)}</div></div>
        <div class="v">${money(payout.advance)}</div>
      </div>
      <div class="row">
        <div class="l"><div class="t">Окончательный расчёт · 10 ${esc(monthGen(payout.nextYm))}</div><div class="s">всё начисленное за ${esc(monthNom(cursor))} за вычетом аванса</div></div>
        <div class="v">${money(payout.rest)}</div>
      </div>
    </div>`;

  html+=`
    <div class="ml">По периодам</div>
    <div class="card">
      <div class="row"><div class="l"><div class="t">1–15 ${esc(monthGen(cursor))}</div></div><div class="v">${money(payout.firstHalfTotal)}</div></div>
      <div class="row"><div class="l"><div class="t">16–${lastDayOfMonth(cursor)} ${esc(monthGen(cursor))}</div></div><div class="v">${money(payout.secondHalfTotal)}</div></div>
    </div>
    <div class="note">Оплата за смены с учётом штрафов. Премии показаны отдельно ниже. Неполная смена округляется до целого рубля отдельно по каждой смене.</div>`;

  html+=`
    <div class="ml">Состав начислений</div>
    <div class="card">
      <div class="row"><div class="l"><div class="t">Оплата за смены</div><div class="s">${shiftsSummary}</div></div><div class="v">${money(aggregate.base)}</div></div>
      <div class="row"><div class="l"><div class="t">Премии</div></div><div class="v pos">${aggregate.bonus?"+ ":""}${money(aggregate.bonus)}</div></div>
      <div class="row"><div class="l"><div class="t">Штрафы</div></div><div class="v neg">${aggregate.fine?"− ":""}${money(aggregate.fine)}</div></div>
      <div class="row total"><div class="l"><div class="t">Итого за ${esc(monthNom(cursor))}</div></div><div class="v">${money(aggregate.total)}</div></div>
    </div>`;

  return html;
}

function viewData(){
  let title;
  let detail;
  let statusClass="";

  if(loadError){
    title="Ошибка чтения данных";
    detail="Сохранённая база не была изменена. Можно скачать исходные данные или восстановить последнюю исправную копию.";
    statusClass="off";
  }else if(syncConflict){
    title="Конфликт изменений";
    detail="Другая вкладка изменила базу. Обновите данные перед следующей записью.";
    statusClass="off";
  }else if(store.mode==="memory"){
    title="Временное хранение";
    detail=`Записей: ${shifts.length}. Браузер запретил постоянное хранилище; данные сохраняются только до закрытия этой страницы.`;
    statusClass="off";
  }else if(!storageOk){
    title="Ошибка сохранения";
    detail="Последнее изменение не было принято. Существующая сохранённая база не заменена.";
    statusClass="off";
  }else{
    title="Сохранено на этом устройстве";
    detail=`Записей: ${shifts.length}. Для переноса на другое устройство используйте резервную копию JSON.`;
  }

  const recoveryActions=loadError
    ? `
      <button class="btn" id="doRawExport">Скачать исходные данные</button>
      ${hasBackup?`<button class="btn gold" id="doRestoreBackup">Восстановить последнюю исправную копию</button>`:""}
      <div class="ml">Замена из резервной копии</div>
      <textarea id="dataImportInput" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Вставьте исправный JSON сюда"></textarea>
      <button class="btn gold" id="doImport">Заменить повреждённые данные</button>
      <div class="note">Повреждённая исходная копия будет сохранена отдельно перед заменой.</div>
    `
    : syncConflict
      ? `<button class="btn gold" id="doReloadData">Обновить данные</button>`
      : "";

  const backupAction=hasBackup && !loadError
    ? `<button class="btn" id="doRestoreBackup">Вернуть предыдущую сохранённую версию</button>`
    : "";

  return `
    <div class="ml">Состояние</div>
    <div class="card">
      <div class="row">
        <div class="dot ${statusClass}"></div>
        <div class="l"><div class="t">${esc(title)}</div><div class="s wrap">${esc(detail)}</div></div>
      </div>
    </div>
    ${recoveryActions}

    ${loadError?"":`
      <div class="ml">Резервная копия</div>
      <button class="btn gold" id="doExport">Скачать JSON</button>
      <button class="btn" id="doCopyJson">Скопировать JSON</button>
      ${backupAction}

      <div class="note">Резервная копия содержит версию схемы, версию правил и ревизию данных.</div>
      <textarea id="dataImportInput" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Вставьте JSON сюда"></textarea>
      <button class="btn gold" id="doImport">Загрузить данные</button>
      <div class="note">Перед заменой приложение автоматически сохранит предыдущую исправную версию.</div>

      <div class="ml">Опасная зона</div>
      <button class="btn warn" id="doWipe">Удалить все смены</button>
      <div class="note">После удаления предыдущую сохранённую версию можно восстановить из раздела «Данные».</div>
    `}

    <div class="developer-credit">Shift Register ${APP_VERSION} · правила ${RULES_VERSION} · разработчик emilsvifullin</div>
  `;
}

/* ========== форма ========== */
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
          date:localYMD(),
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
    sheet.scrollTop=Math.max(0,restoredScrollTop);
    void sheet.offsetHeight;
    requestAnimationFrame(()=>{
      sheet.style.removeProperty("transition");
      veil.style.removeProperty("transition");
      document.getElementById("sheetCancel").focus();
    });
  }else{
    requestAnimationFrame(()=>{
      sheet.scrollTop=Math.max(0,restoredScrollTop);
      document.getElementById("sheetCancel").focus();
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
  },320);
}

let datePickerHideTimer;
let dateCalendarCursor="";
let datePickerValue="";
let dateJumpYear=0;
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
          class="date-jump-month ${ym===dateCalendarCursor?"on":""}"
          data-calendar-month="${ym}"
        >
          ${month}
        </button>
      `;
    }).join("");
}

function openDateJump(){
  dateJumpYear=Number(dateCalendarCursor.slice(0,4));

  drawDateJump();

  document.getElementById("dateJump").classList.add("on");
  document.getElementById("datePicker").classList.add("jump-open");

  document
    .getElementById("datePickerMonth")
    .setAttribute("aria-expanded","true");
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
  },320);
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
  },320);
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
      ${draft.partial?`<label class="row"><div class="t">Часов</div><input type="number" inputmode="decimal" min="0.5" max="11.5" step="0.5" id="f-hours" value="${esc(draft.hours)}" placeholder="0" aria-label="Часов"></label>`:""}
    </div>

    <div class="ml">Премии и штрафы</div>
    <div class="card">
      <label class="row"><div class="t">Премии</div><input type="number" inputmode="numeric" min="0" max="${MAX_MONEY}" step="1" id="f-bonus" value="${esc(draft.bonus)}" placeholder="0" aria-label="Премии"></label>
      <label class="row"><div class="t">Штрафы</div><input type="number" inputmode="numeric" min="0" max="${MAX_MONEY}" step="1" id="f-fine" value="${esc(draft.fine)}" placeholder="0" aria-label="Штрафы"></label>
    </div>

    <div class="ml">Расчёт</div>
    <div class="calc" id="calcBox">${calcHTML()}</div>
    ${isEdit?`<button type="button" class="btn warn" id="f-del">Удалить смену</button>`:""}
    <div class="sheet-spacer" aria-hidden="true"></div>`;
}

function readForm(){
  const get=id=>document.getElementById(id);

  if(get("f-shk")) draft.shk=get("f-shk").value;

  if(get("f-hours")){
    draft.hours=
      get("f-hours").value===""
        ? ""
        : Number(get("f-hours").value);
  }

  if(get("f-bonus")) draft.bonus=get("f-bonus").value;
  if(get("f-fine")) draft.fine=get("f-fine").value;
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

function validateDraft(value){
  if(!isValidDateString(value.date)) return {message:`Выберите дату с ${MIN_YEAR} по ${MAX_YEAR} год`,fieldId:"f-date-open"};
  if(!POINTS.includes(value.point)) return {message:"Выберите пункт",fieldId:"f-point-open"};

  if(!isFixedPoint(value.point)){
    const error=validateWholeField(value.shk,"ШК",{allowEmpty:true,max:MAX_SHK});
    if(error) return {message:error,fieldId:"f-shk"};
  }

  if(value.partial){
    const hours=Number(value.hours);
    if(!Number.isFinite(hours) || hours<.5 || hours>11.5 || !Number.isInteger(hours*2)){
      return {message:"Укажите часы от 0,5 до 11,5 с шагом 0,5",fieldId:"f-hours"};
    }
  }

  const bonusError=validateWholeField(value.bonus,"Премия",{max:MAX_MONEY});
  if(bonusError) return {message:bonusError,fieldId:"f-bonus"};
  const fineError=validateWholeField(value.fine,"Штраф",{max:MAX_MONEY});
  if(fineError) return {message:fineError,fieldId:"f-fine"};

  try{
    normalizeDraftForSave(value,shifts.find(item=>item.id===value.id) || null);
  }catch(error){
    return {message:error instanceof Error ? error.message : "Некорректные данные смены",fieldId:null};
  }

  return null;
}

function normalizedDraft(value){
  return normalizeDraftForSave(value,shifts.find(item=>item.id===value.id) || null);
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
  },320);
}

function selectMonth(ym){
  cursor=ym;
  closeMonthPicker();
  render();
  window.scrollTo(0,0);
}

/* ========== события ========== */
document.getElementById("prevM").onclick=()=>{cursor=shiftMonth(cursor,-1);render();};
document.getElementById("nextM").onclick=()=>{cursor=shiftMonth(cursor,1);render();};
document.getElementById("period").onclick=openMonthPicker;


document.getElementById("monthVeil").onclick=closeMonthPicker;

document.getElementById("monthYearPrev").onclick=()=>{
  monthPickerYear=Math.max(MIN_YEAR,monthPickerYear-1);
  drawMonthPicker();
};

document.getElementById("monthYearNext").onclick=()=>{
  monthPickerYear=Math.min(MAX_YEAR,monthPickerYear+1);
  drawMonthPicker();
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
  monthPickerValue=
    ymOf(new Date());

  monthPickerYear=Number(
    monthPickerValue.slice(0,4)
  );

  drawMonthPicker();
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

const monthPickerHandle=
  document.getElementById("monthPickerHandle");

let monthPickerDrag=null;

monthPickerHandle.addEventListener("pointerdown",e=>{
  if(
    !e.isPrimary ||
    !monthPickerElement.classList.contains("on")
  ){
    return;
  }

  monthPickerDrag={
    id:e.pointerId,
    startY:e.clientY,
    distance:0,
    started:performance.now()
  };

  monthPickerElement.style.transition="none";
  monthPickerHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

monthPickerHandle.addEventListener("pointermove",e=>{
  if(
    !monthPickerDrag ||
    e.pointerId!==monthPickerDrag.id
  ){
    return;
  }

  const distance=Math.max(
    0,
    e.clientY-monthPickerDrag.startY
  );

  monthPickerDrag.distance=distance;

  monthPickerElement.style.setProperty(
    "--month-drag",
    distance+"px"
  );

  e.preventDefault();
});

function finishMonthPickerDrag(e){
  if(
    !monthPickerDrag ||
    e.pointerId!==monthPickerDrag.id
  ){
    return;
  }

  const {id,distance,started}=monthPickerDrag;
  const duration=Math.max(1,performance.now()-started);
  const fastSwipe=distance>=28 && distance/duration>=.45;
  const shouldClose=distance>=80 || fastSwipe;

  monthPickerDrag=null;

  if(monthPickerHandle.hasPointerCapture(id)){
    monthPickerHandle.releasePointerCapture(id);
  }

  monthPickerElement.style.removeProperty("transition");

  if(shouldClose){
    closeMonthPicker();
    return;
  }

  requestAnimationFrame(()=>{
    monthPickerElement.style.removeProperty("--month-drag");
  });
}

monthPickerHandle.addEventListener(
  "pointerup",
  finishMonthPickerDrag
);

monthPickerHandle.addEventListener("pointercancel",e=>{
  if(
    !monthPickerDrag ||
    e.pointerId!==monthPickerDrag.id
  ){
    return;
  }

  monthPickerDrag=null;
  monthPickerElement.style.removeProperty("transition");

  requestAnimationFrame(()=>{
    monthPickerElement.style.removeProperty("--month-drag");
  });
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

  cursor=nextCursor;

  render();

  window.scrollTo(0,0);

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

document.addEventListener(
  "click",
  e=>{
    if(!suppressMonthClick){
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true
);

["shifts","stats","data"].forEach(name=>{
  const button=document.getElementById("tab-"+name);

  button.onclick=()=>{
    tab=name;
    render();
    window.scrollTo(0,0);
  };

  button.addEventListener("keydown",e=>{
    if(!["ArrowLeft","ArrowRight"].includes(e.key)) return;

    e.preventDefault();

    const tabs=["shifts","stats","data"];
    const current=tabs.indexOf(tab);
    const direction=e.key==="ArrowRight" ? 1 : -1;
    const next=tabs[(current+direction+tabs.length)%tabs.length];

    tab=next;
    render();
    window.scrollTo(0,0);
    document.getElementById("tab-"+next).focus();
  });
});
document.getElementById("fab").onclick=()=>openSheet(null);
document.getElementById("veil").onclick=closeSheet;
document.getElementById("sheetCancel").onclick=closeSheet;
document.getElementById("pointVeil").onclick=closePointPicker;
document.getElementById("dateVeil").onclick=closeDatePicker;

document.getElementById("datePrev").onclick=()=>{
  dateCalendarCursor=shiftMonth(dateCalendarCursor,-1);
  drawDatePicker();
};

document.getElementById("dateNext").onclick=()=>{
  dateCalendarCursor=shiftMonth(dateCalendarCursor,1);
  drawDatePicker();
};

document.getElementById("datePickerMonth").onclick=()=>{
  toggleDateJump();
};

document.getElementById("dateJumpPrevYear").onclick=()=>{
  dateJumpYear=Math.max(MIN_YEAR,dateJumpYear-1);
  drawDateJump();
};

document.getElementById("dateJumpNextYear").onclick=()=>{
  dateJumpYear=Math.min(MAX_YEAR,dateJumpYear+1);
  drawDateJump();
};

document.getElementById("dateJumpMonths").onclick=e=>{
  const month=e.target.closest("[data-calendar-month]");

  if(!month) return;

  dateCalendarCursor=month.dataset.calendarMonth;

  closeDateJump();
  drawDatePicker();
};

const datePickerElement=
  document.getElementById("datePicker");

const datePickerHandle=
  document.getElementById("datePickerHandle");

let datePickerDrag=null;

datePickerHandle.addEventListener("pointerdown",e=>{
  if(
    !e.isPrimary ||
    !datePickerElement.classList.contains("on")
  ){
    return;
  }

  closeDateJump();

  datePickerDrag={
    id:e.pointerId,
    startY:e.clientY,
    distance:0,
    started:performance.now()
  };

  datePickerElement.style.transition="none";

  datePickerHandle.setPointerCapture(e.pointerId);

  e.preventDefault();
});

datePickerHandle.addEventListener("pointermove",e=>{
  if(
    !datePickerDrag ||
    e.pointerId!==datePickerDrag.id
  ){
    return;
  }

  const distance=Math.max(
    0,
    e.clientY-datePickerDrag.startY
  );

  datePickerDrag.distance=distance;

  datePickerElement.style.setProperty(
    "--date-drag",
    distance+"px"
  );

  e.preventDefault();
});

function finishDatePickerDrag(e){
  if(
    !datePickerDrag ||
    e.pointerId!==datePickerDrag.id
  ){
    return;
  }

  const {
    id,
    distance,
    started
  }=datePickerDrag;

  const duration=Math.max(
    1,
    performance.now()-started
  );

  const fastSwipe=
    distance>=28 &&
    distance/duration>=0.45;

  const shouldClose=
    distance>=80 ||
    fastSwipe;

  datePickerDrag=null;

  if(datePickerHandle.hasPointerCapture(id)){
    datePickerHandle.releasePointerCapture(id);
  }

  datePickerElement.style.removeProperty("transition");

  if(shouldClose){
    closeDatePicker();
    return;
  }

  requestAnimationFrame(()=>{
    datePickerElement.style.removeProperty("--date-drag");
  });
}

datePickerHandle.addEventListener(
  "pointerup",
  finishDatePickerDrag
);

datePickerHandle.addEventListener("pointercancel",e=>{
  if(
    !datePickerDrag ||
    e.pointerId!==datePickerDrag.id
  ){
    return;
  }

  datePickerDrag=null;

  datePickerElement.style.removeProperty("transition");

  requestAnimationFrame(()=>{
    datePickerElement.style.removeProperty("--date-drag");
  });
});

const dateGrid=document.getElementById("dateGrid");

dateGrid.onclick=e=>{
  if(dateSwipeBlockClick) return;

  const day=e.target.closest("[data-date]");

  if(!day) return;

  datePickerValue=day.dataset.date;

  dateCalendarCursor=
    datePickerValue.slice(0,7);

  closeDateJump();
  drawDatePicker();
};

dateGrid.addEventListener("pointerdown",e=>{
  if(!e.isPrimary) return;

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
    dateCalendarCursor=shiftMonth(
      dateCalendarCursor,
      dx<0 ? 1 : -1
    );

    closeDateJump();
    drawDatePicker();
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
  datePickerValue=localYMD();

  dateCalendarCursor=
    datePickerValue.slice(0,7);

  closeDateJump();
  drawDatePicker();
};

document.getElementById("dateCancel").onclick=()=>{
  closeDatePicker();
};

document.getElementById("dateDone").onclick=()=>{
  if(!datePickerValue) return;

  selectDate(datePickerValue);
};
  const shiftSheet=document.getElementById("sheet");

let sheetDrag=null;

shiftSheet.addEventListener("pointerdown",event=>{
  const dragArea=event.target.closest(".grab,.shead");
  if(
    !event.isPrimary ||
    !dragArea ||
    event.target.closest("button") ||
    !shiftSheet.classList.contains("on")
  ) return;

  sheetDrag={id:event.pointerId,startY:event.clientY,distance:0};
  shiftSheet.style.transition="none";
  shiftSheet.setPointerCapture(event.pointerId);
  event.preventDefault();
});

shiftSheet.addEventListener("pointermove",event=>{
  if(!sheetDrag || event.pointerId!==sheetDrag.id) return;
  sheetDrag.distance=Math.max(0,event.clientY-sheetDrag.startY);
  shiftSheet.style.setProperty("--sheet-drag",sheetDrag.distance+"px");
  event.preventDefault();
});

function finishSheetDrag(event){
  if(!sheetDrag || event.pointerId!==sheetDrag.id) return;
  const {id,distance}=sheetDrag;
  sheetDrag=null;

  if(shiftSheet.hasPointerCapture(id)) shiftSheet.releasePointerCapture(id);
  shiftSheet.style.transition="transform .28s cubic-bezier(.32,.72,0,1)";

  if(distance>=90){
    closeSheet();
  }else{
    shiftSheet.style.setProperty("--sheet-drag","0px");
    setTimeout(()=>{
      shiftSheet.style.removeProperty("transition");
      shiftSheet.style.removeProperty("--sheet-drag");
    },300);
  }
}

shiftSheet.addEventListener("pointerup",finishSheetDrag);
shiftSheet.addEventListener("pointercancel",finishSheetDrag);
const pointPicker=
  document.getElementById("pointPicker");

const pointPickerHandle=
  document.getElementById("pointPickerHandle");

let pointDrag=null;

pointPickerHandle.addEventListener("pointerdown",event=>{
  if(
    !event.isPrimary ||
    !pointPicker.classList.contains("on")
  ){
    return;
  }

  pointDrag={
    id:event.pointerId,
    startY:event.clientY,
    distance:0
  };

  pointPicker.style.transition="none";
  pointPickerHandle.setPointerCapture(event.pointerId);
  event.preventDefault();
});

pointPickerHandle.addEventListener("pointermove",event=>{
  if(!pointDrag || event.pointerId!==pointDrag.id) return;
  pointDrag.distance=Math.max(0,event.clientY-pointDrag.startY);
  pointPicker.style.setProperty("--point-drag",pointDrag.distance+"px");
  event.preventDefault();
});

function finishPointDrag(event){
  if(!pointDrag || event.pointerId!==pointDrag.id) return;
  const {id,distance}=pointDrag;
  pointDrag=null;

  if(pointPickerHandle.hasPointerCapture(id)) pointPickerHandle.releasePointerCapture(id);
  pointPicker.style.removeProperty("transition");

  if(distance>=80){
    closePointPicker();
  }else{
    pointPicker.style.setProperty("--point-drag","0px");
    setTimeout(()=>pointPicker.style.removeProperty("--point-drag"),300);
  }
}

pointPickerHandle.addEventListener("pointerup",finishPointDrag);
pointPickerHandle.addEventListener("pointercancel",finishPointDrag);
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
  if(["f-shk","f-hours","f-bonus","f-fine"].includes(e.target.id)){
    readForm();

    const box=document.getElementById("calcBox");

    if(box){
      box.innerHTML=calcHTML();
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
        : "Вернуть предыдущую сохранённую версию? Текущая версия будет сохранена отдельно.",
      {okText:"Восстановить"}
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
        ? `Заменить повреждённые данные исправной копией (${shiftsWord(imported.length)})?`
        : (shifts.length
            ? `Заменить все текущие смены данными из резервной копии (${shiftsWord(imported.length)})?`
            : `Загрузить ${shiftsWord(imported.length)} из резервной копии?`),
      {okText:loadError || shifts.length ? "Заменить" : "Загрузить"}
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
      "Удалить все смены? Предыдущая сохранённая версия останется доступна для восстановления.",
      {okText:"Удалить всё",danger:true}
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
window.addEventListener("scroll",()=>{
  clearTimeout(scrollTimer);
  scrollTimer=setTimeout(saveUIState,150);
},{passive:true});

let sheetScrollTimer;
document.getElementById("sheet").addEventListener("scroll",()=>{
  clearTimeout(sheetScrollTimer);
  sheetScrollTimer=setTimeout(saveUIState,150);
},{passive:true});

window.addEventListener("pagehide",saveUIState);
document.addEventListener("freeze",saveUIState);

window.addEventListener("pageshow",()=>{
  const ui=loadUIState();
  window.scrollTo(0,ui.scrollY || 0);
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
