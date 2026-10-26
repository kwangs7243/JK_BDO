import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyMasterNameRules,prepareLiveTradeRows} from '../../barter/frontend/js/domain/trade-import.js';
const catalog=JSON.parse(await readFile(new URL('../../barter/frontend/data/trade-catalog.json',import.meta.url),'utf8'));
const makeRow=()=>({fields:Object.fromEntries(Object.entries({island:'일리야 섬',fromItem:catalog.masterData[6][0],
  toItem:'타리프의 마법 항아리',reqAmount:1,count:1,yield:1}).map(([key,value])=>[key,{corrected:value,rawOCR:String(value),reviewRequired:false}]))});
const row=makeRow(),field=row.fields.toItem;
Object.assign(field,{rawOCR:'[7단계] 타리프의 주술 항아리',reviewRequired:true,valueSource:'OCR_CANDIDATE',
  variants:[{text:'[7단계] 타리프의 주술 항아리',confidence:.97},{text:'[7단계] 타리프의 주술항아리',confidence:.97}],
  catalogNameConflict:{readName:'타리프의 주술 항아리',catalogCandidate:field.corrected,agreeingReadings:2},
  reviewReason:'원문과 마스터 후보가 다릅니다.',importReview:true,conflictReview:true});
for(let i=0;i<3;i++){
  applyMasterNameRules(row,catalog);prepareLiveTradeRows({rows:[row]},catalog);
  assert.equal(field.reviewRequired,true,'master matching and repeated review rendering must preserve the hold');
  assert.equal(field.masterMatch,'CONFLICT');assert.equal(field.rawOCR,'[7단계] 타리프의 주술 항아리');
  assert.match(field.reviewReason,/다릅니다/);
}
field.valueSource='USER_REVIEW';field.reviewRequired=false;
prepareLiveTradeRows({rows:[row]},catalog);
assert.equal(field.reviewRequired,false);assert.equal(field.catalogNameConflict,undefined);
const ordinary=makeRow();ordinary.fields.toItem.rawOCR='타리프의 마법항아리';
applyMasterNameRules(ordinary,catalog);assert.equal(ordinary.fields.toItem.reviewRequired,false);
console.log('PASS: catalog-name disagreement survives master correction and review rebuilding; explicit user confirmation resolves it; normal names remain automatic');
