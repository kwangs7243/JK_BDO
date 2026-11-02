# 실사 기록 기반 인식 패치 지침

기준: 2026-11-02, worker v21. 물교·창고 실사 조사와 확장 작업자는 먼저 정독한다. 실행 전 소스/설치 앱 버전·해시를 다시 확인한다. 이 문서는 데이터 삭제·임계값 완화·배포의 상시 승인이 아니다.

## 목표와 경계

현재 폰트·native 크기를 우선한다. 평소 사용 중 부족한 근거의 원본과 검수 기록이 모이면 작업 모델이 **캡처 원본을 직접 읽어** 정답을 확인하고 별도 평가 후 사전을 확장한다. 사용자에게 전수 검수를 떠넘기거나 OCR 답·MASTER 보정·reviewed 단계 자체를 정답으로 복사하지 않는다. DB에 저장됐다는 이유로 실시간 자동 학습하지 않는다.

숫자는 모든 문자열을 저장할 필요가 없다. 원본의 0~9 글자 원형·색·윤곽·가변 폭·간격·완전한 토큰으로 처음 보는 조합도 판독한다. 일부 자릿수 누락·불충분한 근거는 검수한다. 폰트 일반화를 이유로 현재 폰트의 정상 대조를 없애지 않는다. 스케줄·교섭력·마스터·미사용 정책은 인식 확장과 섞지 않는다.

## 실제 실행 경로

| 역할 | 경로 |
|---|---|
| 전체 필드·이름 정답 | `barter/recognition_data/trade-templates.json`, `barter/tools/trade_template_reader.py` |
| 숫자 프로필·핀·증거 | `barter/recognition_data/numeric-profile-{warehouse,trade}.json`, `barter/recognition_profiles.py` |
| 숫자 조합 / 물교 색·횟수 접미부 | `barter/tools/numeric_profile.py`, `trade_numeric_profile.py` |
| 정확한 캐시 → 새 프로필 → 기존 안전 경로 | `barter/tools/numeric_ocr.py` |
| 물교 이름·아이콘·규칙·일괄 추론 | `barter/tools/trade_live_ocr.py` |
| 창고 격자·아이콘·숫자·PATCH | `tools/warehouse_patch/warehouse_patch.py` |
| worker 상태·창고 출처 | `barter/backend/services/trade_batch_runtime.py`, `warehouse_scan.py` |
| 수집 | `barter/backend/storage.py`, `warehouse_feedback.py` |
| 오프라인 fit/evaluate | `barter/tools/fit_numeric_profile.py`, `fit_trade_numeric_profile.py` |

이름 정답/엄격한 아이콘 매치가 있으면 즉시 마스터 이름을 쓴다. OCR도 유일하게 안전한 마스터로 보정되면 보정됐다는 이유로 검수시키지 않는다. 충돌·모호성·미지원은 유지한다. 대양 위치만으로 까마귀주화를 제외하지 않는다.

숫자는 기존 정확한 전체 필드/전체 슬롯 대조를 우선한다. 새 프로필은 물교 native 양쪽 기준선·배율·행 정렬, 창고 실제 43×43 내부 슬롯이 확인된 경우만 적용한다. 횟수는 숫자와 `회` 접미부를 모두 검사한다. 창고 숫자를 고정 폭으로 자르거나 물교 주화에 창고 전처리를 그대로 적용하지 않는다. OCR의 여러 전처리 합의만으로 자동 확정하지 않는다. unknown과 실제 0은 구별한다.

`VERIFIED_NUMERIC_PROFILE`은 pinned 파일·내용 해시, 알고리즘, 완전한 토큰, 입력 픽셀 해시, 자릿수별 원본 referenceId/거리/좌표, 횟수 접미부 증거를 보존한다. 물교 수집 정책 4는 증거와 수량을 함께 검증한다. 이미 확인된 필드는 새 저장 사유가 아니다. 한 필드가 부족해 전체 캡처를 저장하면 알려진 이웃도 포함될 수 있다. 사용자 수정·미해결·기존 이력은 보존한다. 창고는 `warehouse_requires_image` 정책을 유지한다.

캐시는 요청/현재 캡처 범위이며 다음 캡처에서 비운다. 이전 회차 수량 재사용은 없다. 프로필 누락/해시 불일치 시 기존 안전 경로로 돌아간다. GPU·외부 API가 필요 없고 DB 후보로 런타임 프로필을 바꾸지 않는다.

## 이번 검증의 의미

| 평가 | 결과 |
|---|---|
| 창고 단독 DEV 168칸·과거검증 112칸 | 모두 정답, 자동 오답 0 |
| 사용자 새 첨부 원본 56칸, 전체 경로 | 56/56, 오답 0, 숫자 OCR 8→0회, 엔진 약 1.16→0.53초 |
| 물교 TRAIN 1배치·DEV 2배치 후 봉인 TEST | 중복 제거 88행/숫자 264필드 |
| 물교 **단독 코어** TEST 변동 숫자 | 132/143=92.3%, 자동 오답 0. 단독 목표 95% 미달 |
| 기존 정답·규칙과 결합한 **전체 경로** TEST | 263/264 자동 정답, 오답 0, 숫자 검수 6→1 |
| 제품 코드 전체 경로 재생 | OCR 255→99회, 모델 초기화 제외 약 11.14→7.78초. 단일 로컬 비교이며 보장값 아님 |
| 이름·품목 288필드 | 전후 동일 |
| 현행 미사용 정책 포함 프론트 | 활성 85·제외 3·중복 8행, 검수 7→2행 |

남은 숫자 1개는 까마귀 둥지 481이다. 후보가 맞아도 증거가 부족해 검수한다. 별도 미지원 이름 검수 1행도 유지한다. 0오답 관찰은 미래 100% 보장이 아니다. 저장/첨부 이미지 재생이며 새 게임·F10 실사는 아니다.

외부 근거: `C:/Users/kwang/.codex/visualizations/2026/10/10/01a123ef-cfd5-7143-8f82-d3e1d06bb44a/recognition-learning-design-20261101/`의 `trade-v2/RESULT.md`, `warehouse-v2/RESULT.md`, `production-verification/`. 원본/정답/NPZ가 없으면 재현했다고 쓰지 않는다. `shared-gap-guard-verification.json`은 폐기된 중간 실패이며 최종은 `shared-gap-guard-final-verification.json`이다. 이미 소비한 봉인 TEST는 이후 회귀이며 새 독립 평가로 세지 않는다.

## 후속 작업 순서

1. Git/설치 worker·사전 해시부터 확인한다. 실제 DB는 SQLite backup API 사본 또는 읽기 전용 트랜잭션으로 조사한다. 테스트로 실제 재고·회차·ROI를 수정하지 않는다.
2. 폰트·원본 크기·엔진별로 묶고 새 캡처를 구분한다. 배치에서 공유될 수 있는 `feedback_id`만으로 이미지를 연결하지 않는다. capture ID·이미지 SHA·rowBox/slotBox·필드를 함께 확인하고 자르기 전에 해시를 검증한다.
3. TRAIN/DEV/새 독립 TEST를 **배치 단위**로 나누고 겹친 행은 observationId로 중복 제거한다. TEST를 보고 표본/판정을 바꾸면 해당 자료는 DEV/회귀가 됐으므로 다음 실사로 다시 평가한다.
4. 원본 native crop을 직접 읽어 라벨을 기록한다. 검수 숫자 외에 자동 통과·빈칸·1/4/7/5/3·다양한 자릿수·노란 횟수와 흰 수량을 조사한다. 잘림/아이콘 혼입/애매한 글자는 승격하지 않는다. 사용자의 적용값도 원본과 다를 수 있다.
5. 이름 확장은 기존 `expand_verified_trade_names` CLI와 원본 확인 manifest를 쓴다. 상세 명령은 `docs/RECOGNITION-EXPANSION-RUNBOOK.md` 6절. 옛 숫자 금지 정책은 적용하지 않고 은행의 기존 이름/숫자/슬롯/빈칸/글자를 모두 보존한다. 충돌 키는 적용 중단한다.
6. 숫자는 원본 배율/영역, 토큰 분리, 미보유 글자 모양, 경쟁 후보, 정확한 캐시 누락, 프론트 증거 전달 문제로 원인을 나눈다. 특정 섬·품목·숫자 예외문이나 confidence 완화를 반복하지 않는다. 11/12px 높이 차이도 원본에서 확인한다.
7. TRAIN 원본 글자 좌표를 annotation으로 지정해 아래 CLI로 외부 후보를 만든다. sourceSha256/group/rowBox 또는 slotBox/글자 box/ORIGINAL_GLYPH_AUDIT를 남긴다. OCR 답을 글꼴로 그린 이미지가 아닌 원본 mask를 쓴다. 전체 필드 복제만으로 일반화 개선이라 하지 않는다.
8. DEV 개선 후 후보를 고정하고 새 TEST를 한 번 평가한다. 단독 코어와 전체 혼합 경로를 분리하고 correctAuto/wrongAuto/review, 새 조합, 이름 변화, 실제 OCR 호출·시간을 기록한다. 규칙 고정 필드는 변동 숫자 분모에서 분리한다. 자동 오답/기존 정상 회귀가 있으면 적용 중단한다.
9. 통과한 프로필만 `VERIFIED_ORIGINAL_GLYPHS`로 승격한다. glyph별 안정된 원본 identity 기반 referenceId·sourceSHA·group·원본 box, countSuffix의 원본 출처를 넣는다. promotedFrom은 실험 profile SHA다. mask/매개변수를 바꾸면 새 후보이므로 다시 평가한다. sha256을 뺀 sorted compact JSON의 SHA를 내부 sha256으로, 최종 파일 바이트 SHA를 `recognition_profiles.PROFILE_FILES` 핀으로 갱신한다. 원본 fixture/기대값을 새 출력에 맞춰 덮어쓰지 않는다.
10. 코드·profile·worker·패키지·출처·수집 증거를 함께 점검한다. source tag만으로 resolved 처리하지 않는다. 좁은 검사와 실제 실행 경로 재생 후 사용자 요청 시 목적별 커밋·푸시·main 병합, **깨끗한 main에서 빌드**한다. 정상 종료·DB/ROI/앱 백업·해시·재시작·운영 상태 보존을 확인한다. 새 게임/F10은 별도 보고한다.

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONUTF8='1'
$taskOcrPython='D:/BDO/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$taskBackendPython='D:/BDO/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
# 외부 dataset/annotation 경로 지정. 입력 스키마는 fit 함수와 대응 unit test 참고.
& $taskOcrPython -B -m barter.tools.fit_numeric_profile fit --dataset $warehouseDataset --glyphs $warehouseAnnotations --out $warehouseCandidate
& $taskOcrPython -B -m barter.tools.fit_numeric_profile evaluate --dataset $warehouseDataset --profile $warehouseCandidate --split dev --out $warehouseDevReport
& $taskOcrPython -B -m barter.tools.fit_trade_numeric_profile fit --dataset $tradeDataset --glyphs $tradeAnnotations --suffix $countSuffixAnnotation --out $tradeCandidate
& $taskOcrPython -B -m barter.tools.fit_trade_numeric_profile evaluate --dataset $tradeDataset --profile $tradeCandidate --split dev --out $tradeDevReport
& $taskOcrPython -B -m unittest local_app.tests.backend.test_numeric_ocr local_app.tests.backend.test_numeric_profile local_app.tests.backend.test_numeric_profiles local_app.tests.backend.test_trade_numeric_profile local_app.tests.backend.test_trade_template_reader local_app.tests.backend.test_trade_live_list
& $taskBackendPython -B -m pytest local_app/tests/backend/test_recognition_collection.py local_app/tests/backend/test_trade_batch_api.py local_app/tests/backend/test_warehouse_scan.py local_app/tests/backend/test_warehouse_quantity_safety.py local_app/tests/backend/test_warehouse_package_assets.py -q
node local_app/tests/trade_unused_policy.mjs
git diff --check
```

fit/evaluate는 DB나 제품 사전을 쓰지 않는다. `*-experimental.json`은 재현용이며 패키지에 넣지 않는다. 전체 물교 비교는 `recognize_live(..., use_numeric_profiles=False/True)`, 창고는 같은 source size로 `NumericOCR(..., use_numeric_profiles=False/True)`를 실제 convert에 전달한다. 초기화 시간과 엔진 시간을 나눈다. 실행하지 않은 검사는 완료로 쓰지 않는다.

## 과거 워크트리 보존

`codex/archive-departure-causality-20261102`는 구 `_dev/local_app`의 출항·무게·인식·검수 미커밋 이력이다. 현재 `barter/`, `local_app/tests/`, `local_app/tests/live/`로 이미 이전된 변경의 hunk·함수·회귀를 대조한 보존 병합이다. 구 `_dev`를 제품에 다시 복사하지 않는다. 개인 설치 환경 `D:/BDO/_dev/recognition-local/`는 이동/삭제하지 않는다.
