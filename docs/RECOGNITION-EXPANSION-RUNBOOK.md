# 현재 폰트 OCR 구조와 후속 정답 확장 작업 지침

기준: 2026-10-27 폰트 변경 이후. 현재 폰트를 유지한다. 이 문서는 이번 작업의 구현 상태와, 후속 구현 모델이 판단을 새로 하지 않고 따라야 할 경계를 기록한다.

## 1. 현재 구현과 결정

- 기본 경로는 **아이콘 식별 + 로컬 신경망 OCR**이다. 숫자 템플릿 대조로 돌아가지 않는다.
- 모델은 이미 검증된 `korean_PP-OCRv5_mobile_rec` ONNX CPU 모델이다. 숫자 전용으로 새로 학습한 모델이라고 표현하지 않는다.
- 물교 품목: `ItemIconReader.match_trade()`의 엄격한 아이콘 매치가 있으면 마스터 이름을 사용한다. 그 외 품목과 섬 이름은 OCR 후 기존 마스터 보정을 사용한다. 정상 마스터 보정을 이유로 검수를 추가하지 않는다.
- 검증된 이름 정답이 있으면 필드 OCR뿐 아니라 선행 일괄 추론에서도 해당 이름을 제외한다. 숫자와 이름의 판정 기준은 바꾸지 않는다.
- 물교 숫자: 잘린 글자가 없는 윤곽에서 요구 수량과 2/3 수율을 먼저 일괄 OCR한다. 완전한 숫자 길이와 다중 입력 합의를 확인한다. 불확실하면 기존 문맥/윤곽 OCR로 보완한다. 주화처럼 아이콘과 겹치는 숫자는 문맥 OCR을 유지한다. 주화에 창고용 숫자 분리를 적용하면 `219→19`, `205→5`가 생겼으므로 금지한다.
- 창고 품목: 숫자 표시를 제외한 아이콘 영역으로 식별한다. 아이콘 은행에는 숫자 픽셀과 수량 정답이 없다.
- 창고 숫자: `NumericOCR`가 숫자 전체를 신경망으로 읽는다. 고정된 8픽셀 자리 분할을 사용하지 않는다. 서로 다른 전처리의 합의가 필요하며 강한 충돌은 다수결로 덮지 않는다. 패딩만 다른 동일 전처리를 독립 확인으로 세지 않는다.
- 판독 불가는 `None`이다. 0으로 채우지 않는다. 5단 창고 재고는 기존처럼 대상에서 제외한다.
- 인식 성공 후 검수/명시 적용, 재고·회차·교섭력·스케줄 계산은 기존 계약을 유지한다.

기존 `CURRENT-PRODUCT-CONTRACT.md`의 숫자 템플릿 및 `warehouse-templates.npz` 설명은 이 교체 이전 구조다. 이번 인식 변경 부분은 이 문서와 실제 코드를 기준으로 한다.

## 2. 실행 경로와 리소스

| 역할 | 현재 경로 |
|---|---|
| 물교 판독·일괄 추론 | `barter/tools/trade_live_ocr.py` |
| 숫자 전처리·합의 판정 | `barter/tools/numeric_ocr.py` |
| 아이콘 특징 계산·식별 | `barter/tools/item_icon_reader.py` |
| 공유 OCR worker·모델 잠금 | `barter/backend/services/trade_batch_runtime.py` |
| 별도 프로세스 진입점 | `barter/tools/trade_batch_worker.py` |
| 창고 API·PATCH 검증 | `barter/backend/services/warehouse_scan.py`, `barter/backend/api/scan.py` |
| 창고 격자/아이콘·보고서 생성 | `tools/warehouse_patch/warehouse_patch.py` |
| 폰트와 독립적인 아이콘 은행 | `barter/recognition_data/warehouse-icons.npz` |
| 선택적 물교 문자 정답 은행 | `barter/recognition_data/trade-templates.json` |
| 은행 무결성·정확 일치 | `barter/tools/trade_template_reader.py` |
| 수집·출처 보존 | `barter/backend/storage.py`의 `_trade_sample_collection`, `record_trade_corrections` |
| DB 추출·후보 은행·전후 비교 CLI | `barter/tools/expand_verified_trade_names.py` |
| 창고 이미지 보관·수정 원본 검증 | `barter/backend/warehouse_feedback.py`, `barter/frontend/js/patch-review.js` |
| 패키지 입력 | `local_app/packaging/bdo-suite.spec` |

문자 은행의 기존 폰트 항목은 백업 후 비웠다. 교체 시점에는 `referenceCount=0`이었다. 이후 개수는 실제 JSON으로 조회하며 숫자 OCR은 이 은행에 의존하지 않는다. 빈 은행도 무결성 해시를 맞춰 배포한다. 기존 폰트 `warehouse-templates.npz`는 활성 배포에서 제거했다. `tools/warehouse_patch/quantity_templates.npz`는 과거 검증 도구의 입력으로만 남아 있으며 제품 API의 숫자 판독에 사용하지 않는다.

worker는 물교와 창고가 같은 잠금을 사용한다. 동시에 두 모델 작업을 돌리지 않는다. ONNX 추론 스레드는 1개, 일괄 크기는 최대 8개다. 같은 요청 안에서만 완전히 같은 픽셀 입력의 결과를 재사용한다. 이전 회차 수량이나 재고를 재사용하는 기능이 아니다.

## 3. 이번 검증 자료와 해석

- 외부 작업 자료: `C:/Users/kwang/.codex/visualizations/2026/10/10/01a123ef-cfd5-7143-8f82-d3e1d06bb44a/font-migration-20261027/`
- 창고 원본·보고서: 같은 상위 폴더의 `font-audit-20261027/`
- `manual-numeric-truth.json`: 원본 숫자 접촉표 3장을 직접 읽어 기록한 물교 90행 × 3필드 정답. OCR 출력 복사본이 아니다.
- `final-trade-result.json`, `final-trade-summary.json`: 물교 재생 결과. 270개 숫자 중 269개 자동 확인, 1개는 검수. 자동 통과 오답 0개.
- `warehouse-ui-result.json`: 실제 worker→검수→임시 재고 적용 검증. 55개 자동 확인, 1개 검수, 5단 변경 없음.
- 창고 정답 정정: `R4C2`는 53이다(기존 인식값 3은 오답). `R6C1`은 원본에서 63이며 저장된 수동 확인값 64를 정답으로 사용하면 안 된다. 원본 확인 없이 사용자 피드백을 학습 정답으로 복사하지 않는다.
- `controlled-timing.json`의 기존 경로 29.856초/817회와 최종 경로 약 20.0초/349회는 같은 15장 재생의 로컬 측정이다. 모든 PC·다음 회차·새 게임 화면에서의 보장이 아니다.

원본 전체 캡처와 개인 DB는 Git에 넣지 않는다. 외부 자료가 없으면 정답을 추정하지 말고 해당 검증이 불가능하다고 보고한다.

## 4. 평소 DB 수집 정책

수집 정책 버전은 2다. 기존 이력은 자동 삭제하거나 정답으로 승격하지 않는다. 이미지를 저장할지 결정하는 코드이며 인식 결과·검수 플래그·실제 재고는 바꾸지 않는다.

- 물교: 정상 숫자는 출처가 OCR이어도 저장 사유가 아니다. `VERIFIED_ICON`과 `VERIFIED_TEMPLATE`로 확인한 이름도 저장 사유가 아니다. 정답 대조가 없는 품목/섬 이름, 미해결 필드, 실제 사용자 수정/확인, 빈 결과는 원본 전체 이미지와 모든 행의 출처를 보관한다. 정상적으로 제외된 미사용 행의 미확보 이름만으로는 수집하지 않지만 미해결 필드와 명시 수정의 진단 근거는 유지한다.
- 하나라도 수집할 필드가 있으면 해당 전체 캡처를 저장하므로, 그 안에 이미 정답이 있는 이웃 품목도 포함될 수 있다. 필드 crop만 저장하는 구조가 아니다. 같은 이미지·인식 근거·수정은 upload ID나 화면 단계가 달라도 다시 저장하지 않는다. OCR 후보가 DB에 한 번 있다는 이유만으로 독립 정답으로 취급하지 않는다.
- 창고: 모든 슬롯이 `MATCH`, `EMPTY`, `TIER5_IGNORE`이면 `warehouse_scan.image_png`는 빈 BLOB이다. 재고 적용 검증에 필요한 report/provenance와 scan ID는 유지한다. 검수/오류 슬롯 또는 빈 결과가 있으면 이미지를 보관한다. 같은 이미지·보고서·엔진 출처는 같은 scan ID를 사용한다.
- 창고에서 정상 결과를 실제로 수정한 경우에만 화면이 가진 원본을 `feedback.sourceImagePng`로 전달한다. 서버가 최초 이미지 SHA-256을 확인하고 수정 이력·이미지·재고를 같은 트랜잭션에서 저장한다. 원본이 다르거나 저장이 실패하면 모두 롤백한다. 정상값 그대로 적용하면 이미지를 다시 보내지 않고 빈 수정 이력도 만들지 않는다.
- `GET /api/warehouse-dataset`은 이미지가 있는 스캔만 내보낸다. 정상 스캔의 작은 판독 기록은 남으므로 DB가 전혀 증가하지 않는다는 뜻은 아니다. 이 작업에서 과거 DB 청소를 반복하지 않는다.

## 5. 후속 정답 확장의 허용 범위

기본 결정은 OCR 유지다. 후속 정답 확장은 **품목명·섬 이름 문자 대조를 선택적으로 가속**하는 작업이다. 숫자 모델 교체, 숫자 템플릿 부활, 임계값 완화, 스케줄·재고 계산 수정은 범위 밖이다.

확장 CLI는 구현되어 있다. 후속 모델은 새 인식기나 추출기를 구현하지 않고 **6절의 명령과 중단 조건**을 따른다. 독립 정답이 없으면 후보 수만 보고한다. 사용자가 직접 모든 행을 검사하도록 요구하지 않는다. 필요한 원본 대조는 작업 모델이 수행하며 읽을 수 없는 crop은 승격하지 않는다.

### 승격 가능한 이름 표본

1. 현재 폰트의 원본 픽셀이다. `sourceType=native-screen`, `fidelity.rescaled=false`, `fidelity.evidence=native-pixels`, 프레임 크기 987×456을 모두 만족한다.
2. `reviewRequired=false`, `reviewDraft` 없음, 값이 현재 마스터의 유일한 이름과 일치한다.
3. 다음 독립 근거 중 하나가 있다.
   - 품목명: `valueSource=VERIFIED_ICON`, `iconEvidence`가 있고 현재 코드의 아이콘 거리·간격 조건을 통과한 원본이다.
   - 품목/섬 이름: 실제 `USER_REVIEW` 또는 `USER_EDIT`를 포함하여 원본 이미지 대조 manifest가 있다. 사용자 입력에도 오타가 있었으므로 이 출처만으로 자동 승격하지 않는다.
   - 별도의 원본 이미지 대조 정답 manifest에 이미지 SHA-256, 행 좌표, 필드명, 확정 이름, 검증 일시가 기록돼 있다.
4. OCR의 `MASTER` 보정, 높은 confidence, 여러 OCR 결과의 합의, `phase=reviewed`만으로 독립 정답이라 간주하지 않는다. `reviewed` 스냅샷에도 자동 결과가 섞인다. 기존 은행의 일치 결과만 복제하는 것도 새 독립 근거가 아니다.
5. 숫자 수동 확인 기록으로 섬/품목명을 확인했다고 간주하지 않는다. 이번 `manual-numeric-truth.json`은 이름 정답 자료가 아니다.

### 도구 입력/출력 계약

- 입력: 읽기 전용 DB 또는 DB 스냅샷, 선택적 독립 검증 manifest, 현재 문자 은행, 새 출력 디렉터리. CLI는 읽기 트랜잭션으로 일관된 스냅샷을 읽으며 원본 DB를 수정하지 않는다.
- `sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)`와 `PRAGMA query_only=ON`을 사용한다. 실제 앱 API를 호출하거나 사용자 DB를 변경하지 않는다.
- `trade_correction.details_json`의 snapshot/metadata와 대응 `image_png`를 읽는다. 정답 연결은 이미지 SHA-256 + 행 좌표/ordinal + 필드명으로 한다. 서로 다른 캡처 ID를 행 순서만으로 합치지 않는다.
- `rowBox`로 행을 자른 뒤 현재 `trade_live_ocr.NAME_BOUNDS`와 `_crop`을 사용한다. 저장된 필드 box가 이 범위와 다르면 승격하지 않는다. 임의 크기 변경, 부분 글자 선택, 새 보정 로직을 추가하지 않는다.
- `get_features('item' 또는 'island', crop, extractor)`를 재사용한다. 이름 필드 전체를 비교하며 부분 문자열 매치를 만들지 않는다.
- 은행 버전은 `trade-field-binary-exact-v1`, 키는 기존 `kind|native|...`, `kind|scaled|...` 형식이다. 숫자 `count`, `quantity`, 자리별 숫자 키는 추가하지 않는다.
- 참조의 `source`에 이미지 SHA-256, 폰트 정책, 필드/행 좌표, 확정 이름, 검증 근거/시각을 기록한다. `referenceId`는 검증 시각을 제외한 원본 identity와 검증 종류의 정규화 JSON SHA-256이다. 같은 입력으로 재실행해도 동일하다.
- 같은 특징 키가 서로 다른 이름을 가리키면 해당 키를 등록하지 않고 충돌 목록에 기록한다. 충돌이 하나라도 있으면 이번 은행 전체 적용을 중단한다. 유사도 기준을 낮춰 해결하지 않는다.
- 출력은 외부 디렉터리의 `candidate-bank.json`, `expansion-report.json`, `samples.json`, `labels-template.json`, `crops/`, `contact-*.png`, `captures/`, `replay-captures.json`이다. 기본 동작은 추출과 dry-run이며 소스/DB를 쓰지 않는다.
- 승인된 이번 폰트 epoch만 담는다. `fontPolicy`에 `OCR_PRIMARY_20261027`을 유지하고 원본 `referenceCount`의 의미를 바꾸지 않는다.

### 검증 원칙

1. 동일 표본으로 두 번 생성하여 바이트와 reference ID가 동일한지 검사한다.
2. 구형 폰트 은행·전체 캡처·개인 DB가 소스 변경에 섞이지 않았는지 검사한다.
3. 현재 회차 원본을 OCR 기본 경로와 후보 은행 경로로 각각 1회 재생한다. 숫자 결과와 검수 플래그는 동일해야 한다. 이름이 바뀌면 자동 적용하지 말고 원본 대조 대상으로 보고한다. 자동 통과 오답이나 추가 검수가 생기면 적용하지 않는다.
4. 모델 호출 수와 벽시계 시간을 함께 기록한다. 호출 수만 줄었다고 속도 개선이라고 표현하지 않는다. 처리시간이 5% 넘게 악화하면 적용하지 않고 보고한다.
5. 통과한 후보만 `trade-templates.json`으로 교체하고 파일 SHA-256을 `trade_template_reader.BANK_SHA256`에 정확히 반영한다. PyInstaller 입력과 설치된 해시까지 확인한다.
6. `test_repository_bank_matches_pinned_runtime_integrity`는 이미 현재 정책/해시/참조 개수/이름 키만 허용하는 검증이다. 확장 건수에 맞춰 테스트를 수정할 필요가 없다. 고정된 OCR 기대값·원본 fixture·임계값을 새 출력에 맞춰 덮어쓰지 않는다.
7. 커밋/푸시, 설치 앱 재시작, 운영 DB 정리는 각각 사용자 요청이 있을 때만 수행한다. 데이터 정리는 확장 작업의 기본 단계가 아니다.

### 즉시 중단하고 보고할 조건

- 폰트 epoch나 원본 픽셀 여부를 구분할 수 없음.
- 독립 정답이 없거나 원본과 확인 기록이 충돌함.
- 정답 수를 늘리려면 임계값/마스터/숫자 판독을 바꿔야 함.
- 새 은행이 기존 정상 이름을 바꾸거나 숫자·재고·회차를 변경함.
- 자동 통과 오답이 발견됨. 검수 건수 감소로 이를 정당화하지 않는다.

## 6. 후속 모델의 실제 실행 순서

아래 `$taskOut`은 출력용 새 디렉터리이며 이미 존재하면 덮어쓰지 않는다. 저장소 루트에서 실행한다. 공식 주 체크아웃은 `D:/BDO`이며 별도 worktree에서 작업 중이면 그 저장소 루트를 사용한다. `git status --short`로 기존 변경을 확인하고 관련 없는 변경을 포함하지 않는다.

### A. DB에서 원본과 후보 추출

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$taskPython='D:/BDO/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
$taskOcrPython='D:/BDO/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$taskDatabase=Join-Path $env:LOCALAPPDATA 'BDOBarter/data/bdo.sqlite3'
$taskOut=Join-Path $env:TEMP ('bdo-name-expansion-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
& $taskPython -B -m barter.tools.expand_verified_trade_names --database $taskDatabase --out $taskOut
if ($LASTEXITCODE -ne 0) { throw 'Extraction failed; do not apply a bank.' }
Get-Content -LiteralPath (Join-Path $taskOut 'expansion-report.json')
```

이 명령은 ONNX를 호출하지 않는다. `candidateNames`는 후보 수, `verifiedSamples`는 독립 검증된 표본 수, `newReferences`는 기존 은행에 없는 참조 수이며 마스터 전체의 확보율이 아니다.

`verifiedSamples=0`이어도 이미지가 없다는 뜻은 아니다. `MASTER` 보정만으로 얻은 이름은 자동 정답으로 만들지 않는다. 다음 B에서 작업 모델이 직접 읽을 수 있는 것만 확인한다. 이미지도 없으면 이번에는 확장 가능 0건으로 종료한다.

### B. 필요한 이름만 원본 대조

`contact-*.png`의 후보 명칭과 실제 글자를 직접 읽고, 필요하면 대응하는 `crops/<sampleId>.png`와 `captures/<imageSha256>.png`를 연다. 접촉표의 작은 이미지에서 추측하지 말고 원본 크기의 crop을 우선한다. 숫자는 확장 대상이 아니다.

`labels-template.json`을 외부의 `verified-labels.json`으로 복사하고 **실제로 읽어 확인한 행만** `labels`에 남긴다. 각 행은 다음 형식을 사용한다. `sampleId`와 `value`는 대응하는 `samples.json`의 값을 그대로 사용하고, `verifiedAt`은 실제 UTC 확인 시각으로 바꾼다.

```json
{
  "version": 1,
  "fontPolicy": "OCR_PRIMARY_20261027",
  "labels": [
    {
      "sampleId": "samples.json의 64자리 SHA-256",
      "value": "원본과 일치한 마스터 이름",
      "verification": "ORIGINAL_IMAGE_AUDIT",
      "verifiedAt": "2026-10-27T04:00:00Z"
    }
  ]
}
```

원본이 후보 이름과 다르거나 잘렸거나 다른 폰트이면 확인 표시를 하지 않고 중단 조건으로 보고한다. 후보 값을 바꿔 통과시키지 않는다. `UNVERIFIED`인 행을 manifest에 남기면 CLI가 거부한다.

```powershell
$taskLabels=Join-Path $taskOut 'verified-labels.json'
$taskVerified=$taskOut+'-verified'
& $taskPython -B -m barter.tools.expand_verified_trade_names --database $taskDatabase --out $taskVerified --labels $taskLabels
if ($LASTEXITCODE -ne 0) { throw 'Verified build failed.' }
```

아이콘 출처만으로도 `newReferences`가 있으면 B를 생략하고 `$taskVerified=$taskOut`으로 진행할 수 있다. DB가 갱신된 뒤 같은 후보를 검증할 때는 재추출한 `samples.json`과 원본을 사용한다. manifest에 적은 ID가 해당 자료에 없으면 CLI가 중단한다.

### C. 결정성과 모델 재생

선택한 A 또는 B와 같은 인수로 다른 새 출력 디렉터리에 다시 생성한다. 다음 명령으로 `candidate-bank.json` SHA-256이 일치하는지 확인한다. 그 사이 DB가 바뀌어 결과가 다르면 적용하지 말고 새 스냅샷으로 다시 시작한다.

```powershell
$taskRepeat=$taskVerified+'-repeat'
if ($taskVerified -eq $taskOut) {
  & $taskPython -B -m barter.tools.expand_verified_trade_names --database $taskDatabase --out $taskRepeat
} else {
  & $taskPython -B -m barter.tools.expand_verified_trade_names --database $taskDatabase --out $taskRepeat --labels $taskLabels
}
if ($LASTEXITCODE -ne 0) { throw 'Repeated build failed.' }
if ((Get-FileHash -LiteralPath (Join-Path $taskVerified 'candidate-bank.json')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskRepeat 'candidate-bank.json')).Hash) { throw 'Build is not identical; do not apply.' }
```

`expansion-report.json.readyForReplay=true`이며 `collisions=[]`일 때만 다음으로 진행한다. 앱에서 인식 중이면 무거운 재생을 동시에 실행하지 않는다.

```powershell
$taskModel='D:/BDO/app/_internal/barter/recognition_data/trade-model'
& $taskOcrPython -B -m barter.tools.expand_verified_trade_names --replay $taskVerified --model-dir $taskModel
if ($LASTEXITCODE -ne 0) { throw 'Replay failed; do not apply.' }
Get-Content -LiteralPath (Join-Path $taskVerified 'replay-report.json')
```

CLI는 기존 은행과 후보 은행을 순서대로 재생한다. 후보 해시는 비교 프로세스의 메모리 안에서만 검증하며 소스 무결성 검사를 끄거나 파일을 바꾸지 않는다. 이름·숫자·검수 플래그·행 구성이 달라지거나 호출 수가 늘거나 처리 시간이 5% 넘게 악화하면 `canApply=false`가 된다. 실게임 정확도나 무검수의 보장은 아니다.

### D. 통과한 은행만 소스에 반영

`canApply=true`와 후보 SHA-256을 확인하고 다음을 실행한다. 소스의 이름 은행과 고정 해시만 바꾸며 운영 DB·모델·임계값·품목 마스터는 바꾸지 않는다.

```powershell
$taskGate=Get-Content -Raw -LiteralPath (Join-Path $taskVerified 'replay-report.json') | ConvertFrom-Json
$taskCandidate=Join-Path $taskVerified 'candidate-bank.json'
$taskDigest=(Get-FileHash -LiteralPath $taskCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $taskGate.canApply -or $taskDigest -ne $taskGate.candidateBankSha256) { throw 'Candidate is not approved by replay.' }
$taskBank=Join-Path (Get-Location) 'barter/recognition_data/trade-templates.json'
$taskBuild=Get-Content -Raw -LiteralPath (Join-Path $taskVerified 'expansion-report.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $taskBank -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskBuild.sourceBankSha256) { throw 'Source bank changed; rebuild.' }
$taskReader=Join-Path (Get-Location) 'barter/tools/trade_template_reader.py'
$taskText=[IO.File]::ReadAllText($taskReader)
if ([regex]::Matches($taskText,'(?m)^BANK_SHA256 = "[0-9a-f]{64}"').Count -ne 1) { throw 'Unexpected bank hash declaration.' }
Copy-Item -LiteralPath $taskBank -Destination (Join-Path $taskVerified 'source-bank-before.json')
Copy-Item -LiteralPath $taskCandidate -Destination $taskBank
$taskText=[regex]::Replace($taskText,'(?m)^BANK_SHA256 = "[0-9a-f]{64}"',('BANK_SHA256 = "'+$taskDigest+'"'))
[IO.File]::WriteAllText($taskReader,$taskText,[Text.UTF8Encoding]::new($false))
```

다음 관련 검증만 수행하고, 통과하면 추가 참조 수·대상 품목/섬 이름 수·숫자 차이 0건·검수 차이 0건·모델 호출 수·처리 시간을 보고한다. 자료나 은행의 참조 수를 마스터 전체의 인식률로 표현하지 않는다.

## 7. 관련 검증과 배포

명령은 저장소 루트에서 실행한다. 기존 환경 경로를 이동하거나 새 패키지를 임의 설치하지 않는다.

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHON='D:/BDO/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
& $env:PYTHON -B -m pytest local_app/tests/backend/test_name_expansion.py local_app/tests/backend/test_trade_template_reader.py local_app/tests/backend/test_trade_live_list.py local_app/tests/backend/test_trade_batch_api.py local_app/tests/backend/test_recognition_collection.py local_app/tests/backend/test_warehouse_scan.py local_app/tests/backend/test_warehouse_feedback_v2.py local_app/tests/backend/test_warehouse_package_assets.py -q
if ($LASTEXITCODE -ne 0) { throw 'Related regressions failed.' }
node local_app/tests/browser_warehouse_collection.mjs
if ($LASTEXITCODE -ne 0) { throw 'Warehouse collection browser check failed.' }
git diff --check
```

실제 ONNX 재생/빌드는 `D:/BDO/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe`를 사용한다. 이 환경에는 pytest가 없으므로 위 단위 검증용 Python과 구분한다. 무거운 OCR·브라우저 검사는 순차 실행한다.

패키지 빌드 시 `BDO_PACKAGE_TRADE_MODEL_DIR`에는 검증된 모델 디렉터리, `BDO_PACKAGE_WAREHOUSE_TEMPLATES`에는 **warehouse-icons.npz**를 지정한다. 구형 수량 NPZ를 이 변수에 넣지 않는다.

앱 반영을 요청받았다면 빌드는 다음 명령을 사용한다. 빌드 출력과 전체 캡처는 Git에 넣지 않는다.

```powershell
$env:BDO_PACKAGE_TRADE_MODEL_DIR='D:/BDO/app/_internal/barter/recognition_data/trade-model'
$env:BDO_PACKAGE_WAREHOUSE_TEMPLATES=Join-Path (Get-Location) 'barter/recognition_data/warehouse-icons.npz'
$taskPackage=Join-Path $env:TEMP ('bdo-expansion-package-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
& local_app/packaging/build.ps1 -Python $taskOcrPython -OutputRoot $taskPackage
if ($LASTEXITCODE -ne 0) { throw 'Package build failed.' }
```

배포 전 실제 AppData의 물교/연금 DB와 native ROI를 외부에 일관된 SQLite backup API로 백업하고 ZIP CRC/파일 해시를 검증한다. 현재 실행 앱을 `/api/app/shutdown`으로 정상 종료한 뒤 기존 `D:/BDO/app` 전체를 복구 가능한 이름으로 보존하고 `$taskPackage/dist/app` 전체를 교체한다. 계산 상태를 테스트 DB로 덮어쓰지 않는다. `D:/BDO/BDO 실행.lnk`로 재실행하며 Windows 관리자 창이 실제로 뜨면 사용자 승인만 요청한다.

설치 후 전체 파일 해시가 빌드 출력과 일치하고 `/api/health`, `/suite-health`가 정상인지 확인한다. 운영 DB의 모든 테이블과 ROI가 배포 직전 스냅샷과 일치하는지 확인하고 변경 API를 차단한 새 브라우저 프로필에서 70품목/현재 회차를 읽기 전용으로 확인한다. 인식 확장을 이유로 실제 DB에 과거 이미지를 재주입하지 않는다. 배포/데이터 보존에 실패하면 이전 앱 폴더로 복구하고 성공했다고 보고하지 않는다.

커밋/푸시도 요청받은 경우에만 은행 JSON과 고정 해시, 필요한 관련 소스/검증을 명시 경로로 스테이징한다. 수집 로직과 문서 변경은 확장 데이터와 목적이 다르므로 커밋을 분리한다. `git diff --cached --check` 후 커밋하고 원격 HEAD를 확인한다. 다른 체크아웃의 메인에 반영할 때는 기존 변경이 없는지 확인한 뒤 `--ff-only`만 사용한다.

모든 성공 보고는 단위 검증, 저장 이미지 재생, 임시 DB UI, 설치 앱 실행, 새 게임 화면/F10을 구분한다.
