# 현재 폰트 OCR 구조와 후속 정답 확장 작업 지침

기준: 2026-10-27 폰트 변경 이후. 현재 폰트를 유지한다. 이 문서는 이번 작업의 구현 상태와, 후속 구현 모델이 판단을 새로 하지 않고 따라야 할 경계를 기록한다.

## 1. 현재 구현과 결정

- 기본 경로는 **아이콘 식별 + 로컬 신경망 OCR**이다. 숫자 템플릿 대조로 돌아가지 않는다.
- 모델은 이미 검증된 `korean_PP-OCRv5_mobile_rec` ONNX CPU 모델이다. 숫자 전용으로 새로 학습한 모델이라고 표현하지 않는다.
- 물교 품목: `ItemIconReader.match_trade()`의 엄격한 아이콘 매치가 있으면 마스터 이름을 사용한다. 그 외 품목과 섬 이름은 OCR 후 기존 마스터 보정을 사용한다. 정상 마스터 보정을 이유로 검수를 추가하지 않는다.
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
| 패키지 입력 | `local_app/packaging/bdo-suite.spec` |

문자 은행의 기존 폰트 항목은 백업 후 비웠다. 현재 `referenceCount=0`이며 숫자 OCR은 이 은행에 의존하지 않는다. 빈 은행도 무결성 해시를 맞춰 배포한다. 기존 폰트 `warehouse-templates.npz`는 활성 배포에서 제거했다. `tools/warehouse_patch/quantity_templates.npz`는 과거 검증 도구의 입력으로만 남아 있으며 제품 API의 숫자 판독에 사용하지 않는다.

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

## 4. 후속 정답 확장의 허용 범위

기본 결정은 OCR 유지다. 후속 정답 확장은 **품목명·섬 이름 문자 대조를 선택적으로 가속**하는 작업이다. 숫자 모델 교체, 숫자 템플릿 부활, 임계값 완화, 스케줄·재고 계산 수정은 범위 밖이다.

현재 저장소에 정답 은행 확장 CLI는 없다. 필요하면 아래 계약대로 `barter/tools/expand_verified_trade_names.py`와 좁은 검증만 구현한다. 아래 조건을 만족하는 표본이 없으면 은행을 변경하지 않고 후보/승격 가능 건수를 보고한다.

### 승격 가능한 이름 표본

1. 현재 폰트의 원본 픽셀이다. `sourceType=native-screen`, `fidelity.rescaled=false`, `fidelity.evidence=native-pixels`, 프레임 크기 987×456을 모두 만족한다.
2. `reviewRequired=false`, `reviewDraft` 없음, 값이 현재 마스터의 유일한 이름과 일치한다.
3. 다음 독립 근거 중 하나가 있다.
   - 품목명: `valueSource=VERIFIED_ICON`, `iconEvidence`가 있고 현재 코드의 아이콘 거리·간격 조건을 통과한 원본이다.
   - 품목/섬 이름: 실제 `USER_REVIEW` 또는 `USER_EDIT`와 원본 이미지 대조 기록이 있다.
   - 별도의 원본 이미지 대조 정답 manifest에 이미지 SHA-256, 행 좌표, 필드명, 확정 이름, 검증 일시가 기록돼 있다.
4. OCR의 `MASTER` 보정, 높은 confidence, 여러 OCR 결과의 합의, `phase=reviewed`만으로 독립 정답이라 간주하지 않는다. `reviewed` 스냅샷에도 자동 결과가 섞인다. 기존 은행의 일치 결과만 복제하는 것도 새 독립 근거가 아니다.
5. 숫자 수동 확인 기록으로 섬/품목명을 확인했다고 간주하지 않는다. 이번 `manual-numeric-truth.json`은 이름 정답 자료가 아니다.

### 도구 입력/출력 계약

- 입력: 읽기 전용 DB 스냅샷, 선택적 독립 검증 manifest, 현재 문자 은행, 출력 디렉터리.
- `sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)`와 `PRAGMA query_only=ON`을 사용한다. 실제 앱 API를 호출하거나 사용자 DB를 변경하지 않는다.
- `trade_correction.details_json`의 snapshot/metadata와 대응 `image_png`를 읽는다. 정답 연결은 이미지 SHA-256 + 행 좌표/ordinal + 필드명으로 한다. 서로 다른 캡처 ID를 행 순서만으로 합치지 않는다.
- `rowBox`로 행을 자른 뒤 현재 `trade_live_ocr._crop`의 해당 필드 범위를 사용한다. 임의 크기 변경, 부분 글자 선택, 새 보정 로직을 추가하지 않는다.
- `get_features('item' 또는 'island', crop, extractor)`를 재사용한다. 이름 필드 전체를 비교하며 부분 문자열 매치를 만들지 않는다.
- 은행 버전은 `trade-field-binary-exact-v1`, 키는 기존 `kind|native|...`, `kind|scaled|...` 형식이다. 숫자 `count`, `quantity`, 자리별 숫자 키는 추가하지 않는다.
- 참조에는 `referenceId`, `value`, 이미지 SHA-256, 필드명/좌표, 검증 근거를 기록한다. ID는 이 정보의 정규화 JSON SHA-256으로 만들어 재실행해도 동일하게 한다.
- 같은 특징 키가 서로 다른 이름을 가리키면 해당 키를 등록하지 않고 충돌 목록에 기록한다. 유사도 기준을 낮춰 해결하지 않는다.
- 출력은 먼저 외부 디렉터리에 `candidate-bank.json`, `expansion-report.json`, 충돌/제외 사유를 만든다. dry-run이 기본이다.
- 승인된 이번 폰트 epoch만 담는다. `fontPolicy`에 `OCR_PRIMARY_20261027`을 유지하고 원본 `referenceCount`의 의미를 바꾸지 않는다.

### 검증과 소스 적용 순서

1. 동일 표본으로 두 번 생성하여 바이트와 reference ID가 동일한지 검사한다.
2. 구형 폰트 은행·전체 캡처·개인 DB가 소스 변경에 섞이지 않았는지 검사한다.
3. 현재 회차 원본을 OCR 기본 경로와 후보 은행 경로로 각각 1회 재생한다. 숫자 결과와 검수 플래그는 동일해야 한다. 이름이 바뀌면 자동 적용하지 말고 원본 대조 대상으로 보고한다. 자동 통과 오답이나 추가 검수가 생기면 적용하지 않는다.
4. 모델 호출 수와 벽시계 시간을 함께 기록한다. 호출 수만 줄었다고 속도 개선이라고 표현하지 않는다. 처리시간이 5% 넘게 악화하면 적용하지 않고 보고한다.
5. 통과한 후보만 `trade-templates.json`으로 교체하고 파일 SHA-256을 `trade_template_reader.BANK_SHA256`에 정확히 반영한다. PyInstaller 입력과 설치된 해시까지 확인한다.
6. 빈 은행을 확인하던 `test_repository_bank_matches_pinned_runtime_integrity`는 이 단계에서 ‘현재 정책/해시 일치, 구형 참조 없음’ 검증으로 바꾼다. 고정된 OCR 기대값·원본 fixture·임계값을 새 출력에 맞춰 덮어쓰지 않는다.
7. 커밋/푸시, 설치 앱 재시작, 운영 DB 정리는 각각 사용자 요청이 있을 때만 수행한다. 데이터 정리는 확장 작업의 기본 단계가 아니다.

### 즉시 중단하고 보고할 조건

- 폰트 epoch나 원본 픽셀 여부를 구분할 수 없음.
- 독립 정답이 없거나 원본과 확인 기록이 충돌함.
- 정답 수를 늘리려면 임계값/마스터/숫자 판독을 바꿔야 함.
- 새 은행이 기존 정상 이름을 바꾸거나 숫자·재고·회차를 변경함.
- 자동 통과 오답이 발견됨. 검수 건수 감소로 이를 정당화하지 않는다.

## 5. 관련 검증 명령

명령은 저장소 루트에서 실행한다. 기존 환경 경로를 이동하거나 새 패키지를 임의 설치하지 않는다.

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHON='D:/BDO/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
& $env:PYTHON -B -m pytest local_app/tests/backend/test_numeric_ocr.py local_app/tests/backend/test_trade_template_reader.py local_app/tests/backend/test_warehouse_scan.py local_app/tests/backend/test_trade_batch_runtime.py local_app/tests/backend/test_trade_live_list.py -q
git diff --check
```

실제 ONNX 재생/빌드는 `D:/BDO/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe`를 사용한다. 이 환경에는 pytest가 없으므로 위 단위 검증용 Python과 구분한다. 무거운 OCR·브라우저 검사는 순차 실행한다.

패키지 빌드 시 `BDO_PACKAGE_TRADE_MODEL_DIR`에는 검증된 모델 디렉터리, `BDO_PACKAGE_WAREHOUSE_TEMPLATES`에는 **warehouse-icons.npz**를 지정한다. 구형 수량 NPZ를 이 변수에 넣지 않는다.

모든 성공 보고는 단위 검증, 저장 이미지 재생, 임시 DB UI, 설치 앱 실행, 새 게임 화면/F10을 구분한다.
