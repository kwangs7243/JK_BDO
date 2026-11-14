# 1.1.2 예외 방어 작업 결과

2026-11-14 · `codex/exception-defense-112` · **소스 확정, 실제 앱 미설치**

기준은 1.1.1 `c180c16050bbadf4765e2ae8e98232bd85d56e26`이다. 실제 앱·운영 DB·ROI를 변경하지 않았다. 기존 정상 스케줄과 인식 정책을 유지하면서 저장 실패와 사용자 상태 전환의 안전성을 보완했다. 새 기능 확장이 아닌 저장·사용 오류 수정이므로 PATCH 1.1.2로 정리했다. 소스 확정 시점에는 태그가 없었으며, 후속 1.1.3 메인 정리에서 이 소스에 `v1.1.2` 태그를 부여했다. 1.1.2는 단독 설치하지 않고 1.1.3에 포함해 설치했다.

## 작업 묶음

| 묶음 | 완료 내용 | 주요 위치 |
|---|---|---|
| 입력·복원 검증 | 저장 계획의 제공된 수량·플래그 검증, 실행에 필요한 값이 손상된 계획은 복원 전 거절, 잘못된 bootstrap은 마지막 정상 상태를 덮지 않음 | `barter/backend/session_contracts.py`, `barter/frontend/js/state.js`, `domain/scheduler-runtime.js` |
| 저장 결과 확인 | 불확실한 응답을 성공/실패로 단정하지 않음. 동일 mutationId·본문으로 확인, 저장 확인 후 조회 실패는 GET만 재시도, 미확인 쓰기 뒤 대기열 후속 쓰기를 차단 | `api.js`, `persistence.js` |
| 사용자 흐름 방어 | 회차 없는 진입을 가져오기로 안내, 미저장 회차에서 완료·재계산 차단, 실패 입력 유지, 초기 불러오기/저장 복구 버튼, 모달 안에서도 복구 조작 가능 | `app.js`, `workspace-ui.js`, `plan-lifecycle.js` |
| 공통 실패 처리 | 예상하지 못한 예외를 비공개 세부 정보 없는 JSON 500으로 반환, HTTP 대기 상한, 기존 SQLite 503 응답과 데이터 보존 검증 | `local_app/backend/app.py`, `local_app/frontend/http.js` |
| 검증 | 격리 DB·브라우저·두 창·서버 재시작·실제 SQLite 잠금, 정상 실사 기록 재생 비교 | 아래 검사 목록 |

## 사용자 시나리오 14개

새로 구현한 방어와 기존 방어를 구분한다. 기존 동작을 다시 만든 것으로 보고하지 않는다.

| 상황 | 처리 | 확인 근거 |
|---|---|---|
| 1. 회차 없이 브리핑 진입 | **보완:** 현재 회차로 돌아가 가져오기 버튼에 초점. 안내 후 새 계획을 저장하지 않음 | `browser_exception_defense.mjs` |
| 2. 목록은 있지만 계획이 없음 | 기존: 저장된 설정으로 첫 계획 생성 | `browser_plan_lifecycle.mjs` |
| 3. 모든 행 제외 또는 남은 교환 없음 | 기존: 실행 가능한 계획이 없음을 표시, 출항 선택 막음. 원본 제외·횟수 유지 | `browser_user_flow_guards.mjs`, `browser_voyage_flow.mjs` |
| 4. 미확인 재고·부족 재고·교섭력 부족 | 기존: unknown을 0으로 채우지 않고 계산/완료 거절. **보완:** 좌표 없는 활성 섬은 계산 중단 | 미확인 로컬 재고와 교섭력 0: `browser_user_flow_guards.mjs`; 경유지 재고 부족: `completion_stock_and_parley.mjs` |
| 5. 기존 진행 계획 열기 | 기존: 자동 재계산 없이 진행 계획·선택 방식·수행 단계 복원 | `browser_plan_lifecycle.mjs`, `browser_session_controls.mjs` |
| 6. 목록/설정 변경 뒤 재계산 | 기존: 변경 감지·확인 후 남은 계획 재계산. **보완:** 자동 저장 실패가 있으면 재계산 금지, 응답 유실 시 저장된 새 계획을 옛 계획으로 되돌리지 않음 | `browser_plan_lifecycle.mjs`, `browser_exception_defense.mjs` |
| 7. 수행 시작 후 쾌속/균형 변경 | 기존: 첫 완료 후 방식 고정. 재계산 확인 취소 시 유지 | `browser_plan_lifecycle.mjs` |
| 8. 중복·경합·저장 중 다른 조작 | 기존 완료 영수증·sessionRevision·세대 검사 유지. **보완:** 일반 쓰기도 미확인 응답 이후 차단, 대기열 시작 시 재검사 | `browser_session_conflicts.mjs`, `browser_exception_defense.mjs`, backend working-session 검사 |
| 9. 다른 출항 미리보기에서 완료 시도 | 기존: 미리보기는 현재 수행 차수를 바꾸지 않으며 완료/출발 불가 | `browser_voyage_flow.mjs` |
| 10. 현재 회차 갱신/새 회차 혼동 | 기존: 갱신은 회차 ID·교섭력 보존, 새 회차 적용과 별도. 실패한 인식/적용 입력 보존 | `browser_plan_lifecycle.mjs`, `browser_trade_capture_lifecycle.mjs` |
| 11. 새로고침·서버 재시작·조회 실패 | 기존 진행 복원 유지. **보완:** 같은 탭 새로고침 후 미확인 요청 확인, 저장 확정/조회 실패 구분, 손상된 복구 기록은 명시 확인 후 최신 조회 | `browser_session_controls.mjs`, `browser_exception_defense.mjs` |
| 12. 선택 계획 완료/전체 회차 완료 | 기존: 남은 행이 있으면 계획만 완료로 안내하고 남은 교환으로 이동 | `browser_briefing_refinement.mjs`, `browser_voyage_flow.mjs` |
| 13. 타이머 종료 | 기존: 알림/카운트다운만 수행. 별도 교환 완료 저장·재고 차감으로 취급하지 않음 | `timer_startup_regression.mjs`, 완료·브리핑 검사 |
| 14. 인식·가져오기 실패/빈 결과 | 기존: 실패/빈 결과는 입력 보존, 저장 실패 시 모달 유지. **보완:** 모달 안의 저장 복구 안내가 제목·닫기 버튼을 가리지 않음 | `browser_trade_capture_lifecycle.mjs`, `browser_warehouse_scan.mjs`, `browser_exception_defense.mjs` |

위 시나리오와 검사의 대응은 모든 가능한 입력 조합에 대한 완전성 증명을 뜻하지 않는다. 특히 미확인 재고 검사는 의도적으로 **브라우저 작업 상태의 stock=null**을 만들었으며, 수동 재고 API가 null을 저장했다고 보고하지 않는다. 새 섬 좌표 검사는 코드 경계 검토이며 모든 섬 조합을 실사한 것은 아니다. 타임아웃 기본값 선택·명시 시간 초과는 Node 검사로 확인했다.

## 저장 결과가 불확실할 때

- 연결 끊김·시간 초과·깨진 응답·저장 revision 누락·예상하지 못한 500은 성공으로 처리하지 않는다. 같은 mutationId와 직렬화된 본문을 보관한다.
- 서버의 기존 멱등 영수증으로 결과를 확인한다. 성공 응답을 받은 뒤 bootstrap 조회만 실패했다면 쓰기를 다시 보내지 않는다.
- 재고·설정 저장의 재조회는 편집 중인 회차를 덮어쓰지 않는다. 실패한 회차 편집과 재고 저장의 조회 실패가 겹치는 검사도 통과했다.
- 자동 저장 실패 시 미저장 표식을 남긴다. 이후 편집의 저장이 이전 저장의 성공 표시에 의해 지워지지 않도록 편집 순번을 비교한다.
- 다른 창의 변경과 충돌하면 입력을 유지한다. 최신 서버 회차로 교체할 때에는 확인을 받는다.
- 복구 요청은 같은 탭의 sessionStorage에 저장한다. 브라우저 저장소 접근 불가 시 메모리 안의 재시도는 유지하지만 **새로고침 후 같은 요청 복원은 보장하지 않는다**. 이탈 경고는 유지한다. 일반적인 오프라인 편집·자동 병합 기능을 추가한 것이 아니다.
- 손상된 복구 기록은 임의 본문을 재전송하지 않고, 사용자 확인 후 최신 상태를 조회한다. 실패하면 복구 안내를 유지한다.
- 공통 HTTP 한도는 조회 20초, 일반 쓰기 30초, 인식 관련 330초다. 인식 worker의 기존 300초보다 먼저 잘라 버리지 않도록 여유를 둔다. 연결 취소가 이미 서버에서 수행 중인 저장까지 취소했다고 간주하지 않는다.

## 검사 결과

모든 검사는 격리 SQLite와 별도 브라우저에서 수행했다. 기존 자동화에 필요한 fixture·mock 응답을 사용하며 실제 게임 판독과 구별한다.

- Backend: `test_working_session.py`, `test_storage_api.py` — **29 passed, 6 subtests passed**. 실제 격리 SQLite `BEGIN IMMEDIATE` 잠금 중 쓰기 503·원본 상태 보존, 음수/소수/boolean 수량·플래그 거절, 예상하지 못한 서버 예외의 내부 정보 비노출 포함.
- 새 브라우저: `browser_exception_defense.mjs`, `browser_user_flow_guards.mjs` — 통과. 서버가 실제로 저장한 응답만 깨뜨린 뒤 새로고침·동일 본문 재시도·추가 차감 없음, 자동 저장 실패 복구, 확인된 저장 뒤 반복 GET 실패, 손상된 계획/bootstrap/복구 기록 포함.
- 기존 관련 브라우저: `browser_plan_lifecycle.mjs`, `browser_session_conflicts.mjs`, `browser_session_controls.mjs`, `browser_briefing_refinement.mjs`, `browser_voyage_flow.mjs`, `browser_trade_capture_lifecycle.mjs`, `browser_warehouse_scan.mjs` — 통과.
- 공통 HTTP 사용 영역: `browser_alchemy_lifecycle.mjs`, `browser_craft.mjs` — 통과. 연금·제작노트 UI/DB 기능을 재설계하지 않음.
- Node 경계: `http_response_contract.mjs`, `completion_stock_and_parley.mjs`, `timer_startup_regression.mjs`, `scheduler_generation_lifecycle.mjs` — 통과. 통신·응답 형식·명시 시간 초과, 경유지 재고 차감, 교섭 비용 0 보존, 초기 타이머와 반복 생성 포함.
- 정상 출력 비교: 기존 실사용 생성 기록 **39개/78개 모드**를 1.1.1과 후보에서 재생. `summary` JSON이 전부 일치했다. 새 독립 실사나 새 알고리즘 개선율을 뜻하지 않는다. 개인 기록·결과 JSON은 저장소 밖 `exception-defense-112/normal-plans.json`에 보관.

재현 시 루트에서 backend Python을 `PYTHON`으로 지정하고 `PYTHONUTF8=1`, `PYTHONDONTWRITEBYTECODE=1`을 사용한다. 브라우저 검사는 중복 서버/과부하를 피하기 위해 순차 실행한다. Python 검사는 `python -B -m pytest local_app/tests/backend/test_working_session.py local_app/tests/backend/test_storage_api.py -q`다. 파일별 Node 검사는 `node local_app/tests/<위 파일명>`으로 실행한다.

## 보존 범위와 남은 경계

- 교환 선택·항로 최적화·교환량·교섭 단가·정답 사전·OCR 임계값은 변경하지 않았다. 알 수 없는 입력은 임의 값으로 만들어 계산하지 않는다.
- 실제 앱은 1.1.1을 유지하며 본 작업은 소스와 버전 기록의 커밋·푸시까지 진행한다. 설치·재시작·병합·워크트리 삭제는 수행하지 않는다.
- 새 게임 화면/F10·운영 DB를 이용한 쓰기·설치 패키지 검증은 **미실행**이다. 이번 결과를 전체 프로그램의 모든 예외가 제거됐다는 보장으로 해석하지 않는다.
