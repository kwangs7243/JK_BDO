import { voyageFlow, viewTrip, returnFromTrip, saveVoyageFlow, actionable } from './voyage-flow.js';
import { renderBriefingChoice } from "./briefing-choice.js";
import { state } from './state.js';
import { inventoryIcon } from './inventory-ui.js';
import { totalDepartureDuration } from './duration.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
const number=n=>Number(n||0).toLocaleString('ko-KR');
const tier=t=>Number(t)>0?`${t}단`:t==='coin'?'까마귀 주화':t==='mat'?'특수':'육지';
function item(name,count,t){
 const n=el('span','v-item'),icon=el('span','v-icon'),url=inventoryIcon(name);
 if(url){const img=el('img');img.src=url;img.alt='';img.draggable=false;img.decoding='async';img.onerror=()=>{img.remove();icon.classList.add('v-icon-empty');};icon.append(img);}else icon.classList.add('v-icon-empty');
 const body=el('span','v-item-body');body.append(el('small','v-tier',tier(t)),el('span','v-name',name));
 n.append(icon,body,el('strong','v-quantity','×'+number(count)));return n;
}
export function enhanceVoyageBoard(root,mode,sorties){
 document.querySelectorAll('[data-brief-mode]').forEach(button=>{
  const key=button.dataset.briefMode,plan=state.session.schedule?.[key];if(!plan)return;
  const outcomes=el('span','v-plan-outcomes');
  const header=document.getElementById(`header-${key}`);
  const values=[...header.querySelectorAll('.mode-stat strong')].map(n=>n.textContent);
  for(const [label,value] of [['출항',`${plan.length}회`],['시간',totalDepartureDuration(plan)],['교섭력',values[2]??'—'],['까주',values[3]??'—']]){
    const stat=el('span','v-compare-stat');stat.append(el('small','',label),el('strong','',value));outcomes.append(stat);
  }
  button.replaceChildren(el('span','v-plan-name',key==='speed'?'쾌속':'균형'),outcomes);
 });
 renderBriefingChoice();
 const cards=[...root.querySelectorAll('.sortie-card')];if(!cards.length)return;
 const flow=voyageFlow(mode,sorties);
 const refresh=()=>window.renderModeColumn(root.id,state.session.schedule[mode],mode);
 const tabs=el('nav','voyage-trip-tabs');tabs.setAttribute('aria-label','출항 차수 미리보기');
 const progress=el('div','v-flow-status'),caption=el('span','',`${flow.active+1}차 출항 · ${{cargo:'적재 준비',route:'항로 수행',return:'일리야 복귀',finished:'회차 수행 완료'}[flow.phase]}`);
 progress.append(caption);
 if(flow.view!==flow.active||flow.inspectCargo){const back=el('button','','진행 중인 화면으로 돌아가기');back.type='button';back.onclick=()=>{viewTrip(flow,flow.active,sorties);refresh();};progress.append(el('small','','미리보기'),back);}
 cards.forEach((card,index)=>{
  const sortie=sorties[index],preview=index!==flow.active,tab=el('button','',index===0?'1차 출항':`${index+1}차`);tab.type='button';tab.onclick=()=>{viewTrip(flow,index,sorties);refresh();};tab.setAttribute('aria-pressed',String(flow.view===index));card.hidden=index!==flow.view;tabs.append(tab);
  tab.draggable=true;tab.ondragstart=e=>window.sortieDragStart(e,index,mode);tab.ondragend=window.sortieDragEnd;tab.ondragover=e=>window.sortieDragOver(e,index,mode);tab.ondrop=e=>{window.sortieDrop(e,index,mode);window.renderModeColumn(root.id,state.session.schedule[mode],mode);};card.draggable=false;
  const oldHeading=card.querySelector('.sortie-heading'),cargo=card.querySelector('.sortie-cargo'),route=card.querySelector('.schedule-route'),footer=card.querySelector('.sortie-footer');
  const sailing=el('section','v-sailing'),prep=el('section','v-cargo'),tools=el('div','v-sortie-tools'),toggle=el('button','v-cargo-toggle','출항 적재 보기');toggle.type='button';tools.append(oldHeading,toggle);
  const cargoTitle=el('header','v-cargo-title'),cargoCaption=el('div','v-cargo-caption'),showRoute=el('button','primary v-show-route',preview?'진행 중인 화면으로 돌아가기':flow.phase==='cargo'?'적재 완료 · 항로 시작 →':'항로로 돌아가기');showRoute.type='button';cargoCaption.append(el('h3','',`${index+1}차 출항 적재`),el('span','',`출항 무게 ${number(sortie.startWeight)} LT · ${sortie.trades[0]?.island||'첫 목적지'} 출발`));cargoTitle.append(cargoCaption,showRoute);prep.append(cargoTitle);
  const groups=new Map();
  for(const chip of cargo.querySelectorAll('.cargo-item')){const name=chip.querySelector('.cargo-item-name').textContent,req=sortie.reqItems[name],t=req.isBase?0:req.tier;if(!groups.has(t))groups.set(t,[]);groups.get(t).push({name,count:req.count});}
  for(const [t,items] of groups){const band=el('section','v-cargo-band'),label=el('h4','v-cargo-tier',tier(t)),itemsRoot=el('div','v-cargo-items');for(const i of items)itemsRoot.append(item(i.name,i.count,t));band.append(label,itemsRoot);prep.append(band);}
  if(!groups.size)prep.append(el('p','v-cargo-empty','이 출항에 미리 적재할 품목이 없습니다.'));
  route.classList.add('voyage-route-scroll');const activeIndex=sortie.trades.findIndex(t=>!t.completed&&actionable(t)),active=route.children[activeIndex];
  const hero=el('section','v-current');hero.setAttribute('aria-label','현재 목적지와 교환');
  if(active){
   const trade=sortie.trades[activeIndex],dest=el('div','v-destination');dest.append(el('small','','현재 목적지'),el('h3','',trade.island));hero.append(dest);
   const exchange=el('div','v-current-exchange');
   if(!trade.isWaypoint)exchange.append(item(trade.fromClean,trade.execC*trade.reqA,trade.fromTier),el('span','v-arrow','→'),item(trade.toClean,trade.execC*trade.mult,trade.toTier),el('span','v-current-count',`${trade.execC}회 교환`));
   else exchange.append(el('span','','경유지'),trade.consumed?item(trade.consumed.name,trade.consumed.count,trade.consumed.tier):el('span','','소비할 품목 없음'));
   const actions=active.querySelector('.route-actions'),remove=actions.querySelector('.route-remove-button');if(remove)active.querySelector('.route-content').append(remove);
   actions.querySelector('.route-complete-button').textContent='교환 완료'; actions.querySelector('.route-depart-button').textContent=trade.timerActive?'타이머 중지':'타이머 시작';const timer=active.querySelector('.timer-countdown');hero.append(exchange,actions);if(timer)hero.append(timer);
   const timerButton=actions.querySelector('.route-depart-button');timerButton.addEventListener('click',()=>{timerButton.textContent=trade.timerActive?'타이머 중지':'타이머 시작';});
   const next=el('div','v-next');next.append(el('small','','다음 목적지'),el('strong','',sortie.trades[activeIndex+1]?.island||'일리야 섬 · 귀환'));hero.append(next);active.classList.add('voyage-current-row');
  }
  [...route.children].forEach((row,i)=>{
   const trade=sortie.trades[i],heading=row.querySelector('.route-heading'),oldActions=row.querySelector('.route-actions'),adjust=row.querySelector('.route-yield-adjust'),info=row.querySelector('.route-trade-info'),debug=row.querySelector('.route-explanation'),remove=row.querySelector('.route-remove-button');
   const content=el('div','v-stop-body'),exchange=el('div','v-stop-exchange');
   if(!trade.isWaypoint)exchange.append(item(trade.fromClean,trade.execC*trade.reqA,trade.fromTier),el('span','v-arrow','→'),item(trade.toClean,trade.execC*trade.mult,trade.toTier));else exchange.append(el('span','',trade.consumed?`경유지 · ${trade.consumed.name} ×${number(trade.consumed.count)}`:'경유지 · 교환 없음'));
   content.append(heading,exchange,el('span','v-stop-count',trade.isWaypoint?'경유':`${trade.execC}회 교환`));if(trade.over)content.append(el('span','v-over','과적 구간'));
   const detail=el('details','v-stop-details'),summary=el('summary','','상세');detail.append(summary);for(const n of [info,adjust,oldActions,remove,debug])if(n)detail.append(n);
   const step=row.querySelector('.route-step-number');row.replaceChildren(step,content,detail);
  });
  const routeFoot=el('div','v-route-footer'),jump=el('button','','현재 교환으로');jump.type='button';jump.disabled=!active;jump.onclick=()=>{if(active)route.scrollTo({top:active.offsetTop-route.firstElementChild.offsetTop,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};routeFoot.append(el('span','',`${sortie.trades.filter(t=>t.completed).length} / ${sortie.trades.length} 교환 완료`),jump);
  const returnButton=footer.querySelector('button'),returnTimer=footer.querySelector('.timer-countdown');
  if(!active){
   hero.classList.add('v-return');hero.setAttribute('aria-label','일리야 복귀 및 다음 출항');
   const emblem=el('span','v-return-emblem');emblem.setAttribute('aria-hidden','true');emblem.innerHTML='<svg viewBox="0 0 80 80"><path d="M10 65h60M18 57h44M25 48h30M40 10v38M20 36l20-17 20 17M27 36v12m26-12v12M33 13h14M17 66l-5 7m51-7 5 7"/><circle cx="40" cy="40" r="35"/></svg>';
   const copy=el('div','v-return-copy');copy.append(el('small','',`${index+1}차 교환 완료`),el('h3','','일리야 섬으로 복귀'),el('p','',`${sortie.trades.at(-1)?.island||'마지막 목적지'} → 일리야 섬 · 귀환 후 하역`));
   const details=el('div','v-return-metrics'),seconds=Math.round(Number(sortie.returnTime)*60);details.append(el('span','',`예상 귀환 ${Number.isFinite(seconds)?`${Math.floor(seconds/60)}분 ${seconds%60}초`:'미확인'}`),el('span','',sortie.returnOver?'과적 항해':'쾌속 항해'));copy.append(details);
   const actions=el('div','v-return-actions'),next=el('button','primary v-next-sortie',index+1<cards.length?`복귀 완료 · ${index+2}차 적재 →`:'복귀 완료 · 회차 마치기');next.type='button';
   next.onclick=()=>{if(window.__bdoScheduleRuntime?.pending||state.persistencePending>0){window.showToast('완료 저장이 끝난 뒤 계속하세요.');return;}if(window.ACTIVE_TIMERS?.[`return_${mode}_${index}`])returnButton.click();if(!returnFromTrip(flow,sorties))return;refresh();if(flow.phase==='finished')window.dispatchEvent(new CustomEvent('bdo:round-returned'));};
   if(flow.phase==='finished'&&!preview){copy.querySelector('h3').textContent='일리야 복귀 · 회차 수행 완료';next.textContent='다음 회차 준비';}

   actions.append(returnButton,returnTimer,next);hero.append(emblem,copy,actions);
   const history=el('details','v-completed-route'),summary=el('summary','',`완료한 항로 ${sortie.trades.length}곳 보기`);history.append(summary,route,routeFoot);sailing.append(hero,history);
  }else{
   footer.classList.add('v-return-preview');const caption=el('span','v-return-preview-copy',`교환 후 일리야 섬 복귀 · ${sortie.returnOver?'과적':'쾌속'}`);footer.replaceChildren(caption,returnButton,returnTimer);sailing.append(hero,route,footer,routeFoot);
  }
  card.replaceChildren(tools,prep,sailing);
  const showCargo=preview||flow.inspectCargo||flow.phase==='cargo';
  card.classList.toggle('v-preparing',showCargo);prep.hidden=!showCargo;sailing.hidden=showCargo;
  toggle.textContent=showCargo?'항로 보기':'출항 적재 미리보기';toggle.setAttribute('aria-expanded',String(showCargo));toggle.hidden=!preview&&flow.phase==='cargo';
  toggle.onclick=()=>{if(preview){prep.hidden=!prep.hidden;sailing.hidden=!sailing.hidden;toggle.textContent=prep.hidden?'출항 적재 미리보기':'항로 보기';}else{flow.inspectCargo=!showCargo;saveVoyageFlow();refresh();}};
  showRoute.onclick=()=>{if(preview)viewTrip(flow,flow.active,sorties);else{flow.inspectCargo=false;if(flow.phase==='cargo')flow.phase='route';saveVoyageFlow();}refresh();};
  route.scrollTop=flow.scroll[index]||0;route.onscroll=()=>{flow.scroll[index]=route.scrollTop;};
  returnButton.textContent=window.ACTIVE_TIMERS?.[`return_${mode}_${index}`]?'귀환 타이머 중지':'귀환 타이머 시작';
  returnButton.addEventListener('click',()=>{returnButton.textContent=window.ACTIVE_TIMERS?.[`return_${mode}_${index}`]?'귀환 타이머 중지':'귀환 타이머 시작';});
  if(preview){card.classList.add('v-trip-preview');card.querySelectorAll('button').forEach(b=>{if(b!==toggle&&b!==showRoute)b.disabled=true;});route.querySelectorAll('[draggable]').forEach(n=>n.draggable=false);}
  [...route.children].forEach((row,i)=>{if(i!==activeIndex)row.querySelectorAll('.route-depart-button,.route-complete-button').forEach(b=>b.disabled=true);if(!actionable(sortie.trades[i])){row.classList.add('v-skipped');row.querySelector('.v-stop-count').textContent='0회 · 제외';row.querySelectorAll('.route-depart-button,.route-complete-button').forEach(b=>b.disabled=true);}});
 });
 root.prepend(progress,tabs);saveVoyageFlow();
}
