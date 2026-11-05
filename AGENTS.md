# 저장소 작업 규칙

## 버전과 완료 기록

- 제품 변경을 시작·마무리할 때 `docs/agents/VERSIONING.md`와 `CHANGELOG.md` 최신 항목을 읽는다. 현재 앱 버전의 기준은 `local_app/config.py`의 `VERSION`이다.
- 독립적으로 완료하는 제품 변경 묶음마다 PATCH/MINOR/MAJOR를 판단해 버전을 한 번 올리고, README·Python/Node/Windows 메타데이터와 변경 이력을 함께 갱신한다. 작은 버그·UI 수정과 검증된 정답 확장도 제품 변경이면 PATCH 대상이다. 같은 작업의 재검사·후속 수정만으로 중복 상승하지 않는다.
- 문서·테스트·제품 외 검증 도구만의 변경, 검토·실험만 한 작업은 제품 버전을 올리지 않고 사유를 보고한다. 이전 작업의 미커밋 변경을 임의로 이번 릴리스에 묶지 않는다.
- 마무리에 `python -B tools/check_version.py`와 `git diff --check`를 확인하고 새 버전·실행한 검사·실제 앱 반영 상태를 보고한다. 이 절차는 commit/push/merge/tag/Release 생성 권한을 추가하지 않는다.

## 구현과 데이터 보호

- 스케줄 후속 개선·수집 회차 검토 전에는 `docs/agents/SCHEDULER-FOLLOWUP.md`를 읽는다. 교환량 보존 내해 보완과 교환 선택 정책 변경을 섞지 않는다.

- 공통 서버·실행기·native 수명주기는 `local_app/`, 물교는 `barter/`, 연금은 `alchemy/`, 판독 보조 도구는 `tools/`, 기준 품목은 `reference/`에 있다. 개발·시험·빌드는 저장소 루트에서 실행한다.
- 현재 사용자 기능·화면은 `README.md`와 현재 코드, 버전별 완료 기록은 `CHANGELOG.md`, 개발 역사는 `docs/PROJECT-HISTORY.md`를 확인한다. `docs/CURRENT-PRODUCT-CONTRACT.md`의 저장·인식·계산 보존 계약과 `docs/TESTING.md`의 검증 방법은 유지하되 과거 화면·목표 UI 설명을 현재 구현으로 되돌리는 근거로 쓰지 않는다. `docs/archive/`는 과거 기록이며 현재 작업의 승인이나 제품 동작으로 해석하지 않는다.
- 물교·창고의 실사 분석, 인식 개선, 정답 확장을 시작하기 전에 `docs/agents/RECOGNITION-PATCH.md`를 정독한다. 과거 OCR 중심 지시서만으로 숫자 대조를 되돌리거나 저장 결과를 정답으로 승격하지 않는다.
- 사용자 요청 없이 commit/push/stash/reset/rebase 또는 사용자 데이터 삭제를 하지 않는다. 서로 다른 목적의 커밋을 분리하고 기존 변경을 보존한다.
- 모든 인식 출처와 원문·보정값·검수 사유를 보존한다. 후보를 정답으로 승격하거나 unknown을 0으로 채우지 않는다. 정리 작업에 인식 임계값·품목 마스터·배차 계산 변경을 섞지 않는다.
- 직접·동적 import, worker 실행 경로, 런타임 리소스와 PyInstaller 입력을 함께 확인한다. 검증된 정답 사전과 창고 보정 자료는 `barter/recognition_data/`에서 버전 관리한다.
- 테스트는 임시 DB와 별도 브라우저 프로필을 사용한다. 실제 AppData의 재고·회차·설정·ROI·개선 이력을 검증 목적으로 수정하지 않는다.
- 기존 Windows 환경을 쓸 경우 backend Python은 `D:/BDO/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe`, OCR/package Python은 `D:/BDO/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe`다. 이 설치 환경 경로는 Git 소스 구조와 별개이며 임의로 이동하지 않는다. 새 환경은 루트 `pyproject.toml`을 사용한다.
- Python 검증에는 `-B`, `PYTHONDONTWRITEBYTECODE=1`을 사용한다. Node 브라우저 검사에는 `PYTHON`을 실제 검증용 Python 절대 경로로 지정한다. 무거운 OCR·브라우저 검사는 순차 실행한다.
- 테스트 입력은 `local_app/tests/fixtures/`, 출력은 OS 임시 폴더나 저장소 밖에 둔다. `.local/`, 환경·모델·build/dist/cache·개인 DB·전체 캡처를 Git에 추가하지 않는다.
- 과거 baseline의 `baseline-source/_dev` 경로와 manifest 해시는 그 당시 사본의 계약이다. 현재 소스 위치에 맞춘다는 이유로 frozen snapshot·oracle·해시를 덮어쓰지 않는다.
- 자동 회귀, 저장 이미지 재생, 새 게임 화면/F10, 설치 앱 실행 검증과 사용자 승인을 구분해 보고한다. 앱을 배포할 때만 정상 종료·백업·설치 해시·운영 상태 보존 절차를 수행한다.
