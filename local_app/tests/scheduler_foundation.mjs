import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment,audit} from './scheduler_departure_causality.mjs';

function ordinary({budget=50000,extra=false,stock=0,bonus=10000}={}){
 const {ctx,elements}=environment();elements.maxParley.value=budget;
 ctx.bonus=bonus;ctx.stock=stock;ctx.extra=extra;
 vm.runInContext(`APP_CONFIG.ALLOW_OCEAN='none';APP_CONFIG.DEFICIT_RATIO_BONUS=bonus;APP_CONFIG.PRESERVATION_BONUS=bonus;APP_CONFIG.EMERGENCY_BONUS=bonus;
 inventory={'갈퀴 꽃 씨앗 주머니':{stock:100,target:0},'괴생물 촉수':{stock,target:80},'자수정 파편':{stock:0,target:0},'102년 묵은 황금초':{stock:0,target:5}};
 scannedTrades=[{island:'올비아 해안',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',count:10,reqAmount:1,yield:3}];
 if(extra)scannedTrades.push({island:'아지르 섬',fromItem:'자수정 파편',toItem:'102년 묵은 황금초',count:6,reqAmount:1,yield:1});
 initial=JSON.parse(JSON.stringify(inventory));runAlgorithmAllModes(true);plan=sortiesSpeed;`,ctx);
 audit(ctx.plan,ctx.initial,22689,40259,'speed',10278,15576,budget);
 return ctx;
}
assert.equal(ordinary().plan[0].trades[0].execC,4);
assert.equal(ordinary({extra:true}).plan[0].trades[0].execC,4,'unreachable VIP cannot reserve usable budget');
assert.equal(ordinary({stock:25,bonus:0}).plan[0].trades[0].debug.score,102000);
assert.equal(ordinary({stock:25,bonus:20000}).plan[0].trades[0].debug.score,212000);
assert.equal(ordinary({stock:0,bonus:0}).plan[0].trades[0].debug.score,502000);
assert.equal(ordinary({stock:0,bonus:20000}).plan[0].trades[0].debug.score,542000);

const baseRows=[
 ['하코번 섬','팔랑나비 박제품','발렌시아 사막 보검',5,6,5],
 ['아레하자 마을','102년 묵은 황금초','최고급 감투 상자',5,6,5],
 ['일리야 섬','발렌시아 사막 보검','최고급 하이델산 포도주',6,7,5],
 ['올비아 해안','최고급 감투 상자','금빛 밀가루 포대',6,7,5],
].map(([island,fromClean,toClean,fromTier,toTier,count],originalIndex)=>({island,fromClean,toClean,fromTier,toTier,count,originalIndex,origC:count,currentC:count,reqA:1,mult:1,isCoin:false,isSpec:false,isRandomCoin:false,score:999999}));
function seven(rows,{normal=14379,max=24445,budget=1250000,mode='balance',inventory={'팔랑나비 박제품':{stock:10,target:0},'102년 묵은 황금초':{stock:10,target:0}}}={}){
 const {ctx,elements}=environment();elements.normalWeight.value=normal;elements.maxWeight.value=max;elements.maxParley.value=budget;
 ctx.rows=structuredClone(rows);ctx.initial=inventory;ctx.mode=mode;
 vm.runInContext("inventory=JSON.parse(JSON.stringify(initial));plan=buildTier7Sorties(rows,'t7_3region',mode).sorties",ctx);
 const checked=audit(ctx.plan,inventory,normal,max,mode,10278,15576,budget);
 const counts={};for(const t of ctx.plan.flatMap(s=>s.trades))counts[t.toTier]=(counts[t.toTier]||0)+t.execC;
 assert.equal(counts[6]||0,counts[7]||0,'every generated sixth-tier item reaches seventh tier');
 return {ctx,checked,counts};
}
for(const mode of ['speed','balance'])assert.equal(seven(baseRows,{mode}).counts[7],7);
for(const budget of [0,10278,20556,5*20556,1250000])seven(baseRows,{budget});
assert.equal(seven(baseRows.slice(0,2)).counts[6]||0,0,'missing seventh-tier input must not leave a sixth-tier route');
seven(baseRows.map((r,i)=>i===2?{...r,count:1,origC:1}:r),{normal:10000});
const producing=[{island:'아지르 섬',fromClean:'자수정 파편',toClean:'팔랑나비 박제품',fromTier:4,toTier:5,count:6,origC:6,reqA:1,mult:1,score:100000},baseRows[0],baseRows[2]];
assert.equal(seven(producing,{normal:10000,inventory:{'자수정 파편':{stock:50,target:0},'팔랑나비 박제품':{stock:0,target:5}}}).counts[7],4,'extra whole-batch cargo must reduce connected pairs, not all seventh-tier results');
{
 const {ctx}=environment();
 assert.equal(ctx.legDistance('일리야','하코번 섬'),ctx.legDistance('일리야 섬','하코번 섬'));
 ctx.routeCalibrations={'일리야_하코번 섬':{multiplier:.8},'일리야 섬_하코번':{multiplier:.5},'하코번 섬_일리야':{multiplier:1.2}};
 assert.equal(ctx.applyOceanCurrent('일리야','하코번 섬',100),50);
 assert.equal(ctx.applyOceanCurrent('일리야 섬','하코번',100),50);
 assert.equal(ctx.applyOceanCurrent('하코번','일리야 섬',100),120);
}
console.log('PASS: feasible VIP reservation, effective tuning, paired T6/T7 repair and budget, direction-preserving island aliases');
