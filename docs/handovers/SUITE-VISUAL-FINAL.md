# LUNA 작업 시작점 · 최종 디자인 반영

상태: **최종 디자인 적용 완료 / 실제 앱 반영 완료**. 이 문서는 적용 기준·검증·배포 기록이다.

이 문서를 읽고 아래 순서대로 수행한다. 디자인을 새로 해석하지 않는다. 실제 반영·commit·push는 이 문서를 읽으라는 다음 사용자 메시지에 포함된 요청 범위를 따른다. 이번 준비 작업 자체는 그 동작을 수행하지 않았다.

## 1. 사용할 자료

작업 저장소:
`C:/Users/kwang/.codex/worktrees/4979/BDOBarterDev`

이 문서에서 `$handoff`는 다음 절대 경로다. PowerShell에서 그대로 지정한다.

```powershell
$handoff='C:/Users/kwang/.codex/visualizations/2026/10/10/01a123ef-cfd5-7143-8f82-d3e1d06bb44a/suite-design-final/luna-handoff'
$backend='D:/BDO/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
$env:PYTHONUTF8='1'
$env:PYTHONDONTWRITEBYTECODE='1'
```

최종 시안 갤러리:
`C:/Users/kwang/.codex/visualizations/2026/10/10/01a123ef-cfd5-7143-8f82-d3e1d06bb44a/suite-design-final/index.html`

자료 폴더의 의미:

- `apply.patch`: 제품 소스 8개 파일에 적용할 준비된 패치. **이것이 구현 기준이다.**
- `manifest.json`: 준비 시점 커밋 및 수정 전/후 정규화된 SHA-256. CRLF/LF 차이는 제외하고 비교한다.
- `expected/`: 패치 적용 후 기대하는 8개 파일의 완성 사본. 비교용이다. 소스가 달라졌다고 통째로 덮어쓰는 데 사용하지 않는다.
- `barter-append.css`, `alchemy-append.css`, `craft-append.css`: 앱별 적용 CSS. 패치에 이미 포함돼 있으므로 별도 추가하지 않는다.
- `check-state.py`: 소스 일치·변경 감지·패치 재실행 방지 및 dry-run.
- `check-ui.cjs`: 실제 운영 데이터와 분리된 좁은 브라우저 확인. 기본은 적용한 소스 검사. `--candidate`는 준비된 패치 사본을 브라우저 응답에만 연결해 확인하는 준비용 모드다.
- `release.py`: 실제 앱 반영을 요청받은 경우에만 쓰는 배포 도구. 실행 순서는 아래 5절.
- `PREPARATION-RESULT.json`: 준비 과정에서 실제로 확인한 결과.

**다른 폴더의 예전 인계서·시안이 아니라 이 문서와 이 패치를 기준으로 작업한다.** `theme.cjs`와 `render.cjs` 등 시안 생성기는 제품에 넣거나 실행하지 않는다. 예시 재고·임시 DB·품목 ID 치환·시안용 SVG 아이콘·전체 길이 스크린샷을 위한 높이 해제 CSS는 제품 패치에서 제외했다.

## 2. 확정된 변경

| 파일 | 변경 |
|---|---|
| `barter/frontend/index.html` | 전체 배경용 body class. 그림 띠 제거. 기존 회차 관리 버튼을 동일 ID로 펼침. 앱 이동 링크 추가. 통합 메인 링크 유지 |
| `barter/frontend/css/workspace.css` | 전체 바다 배경, 불투명 작업 표면, 버튼 계층, 창고/브리핑/지도 스타일, 좁은 화면에서도 그림용 행이 생기지 않는 규칙 |
| `alchemy/frontend/index.html` | 전체 배경용 body class. 그림 띠 제거. 앱 이동 링크 추가. 통합 메인 링크 유지 |
| `alchemy/frontend/alchemy.css` | 전체 실험실 배경, 읽기 쉬운 표/입력, 절제된 금속 패널과 버튼 |
| `alchemy/frontend/app.js` | 대시보드·재고·기록·설정의 소개 제목 및 장식 문구만 단순화 |
| `craft/frontend/index.html` | 전체 배경용 body class. 그림 띠 제거. 물교/연금/통합 메인 링크. 짧은 목록·빈 화면 문구 |
| `craft/frontend/style.css` | 전체 책 배경, 불투명 종이, 버튼 계층 및 실제 aria-pressed 상태로 preset 강조 |
| `craft/frontend/app.js` | `renderCalculation()` 시작에서 `[data-count]`의 aria-pressed만 실제 입력값에 맞춰 갱신 |

기존 전용 그림 3개는 이미 Git·설치본에 포함되어 있다. 새로 생성하거나 다시 다운로드하지 않는다. 패키징과 pyproject는 frontend 전체를 포함하므로 추가 변경하지 않는다.

기존 입력값, 버튼 ID, 선택자, name, 이벤트 핸들러, 저장/검수/동시성/미저장 확인은 유지한다. 계산 함수·API·DB·OCR·교섭력·스케줄러·품목 마스터를 수정하지 않는다. 이미지와 달라 보이는 실제 품목 아이콘은 유지한다. 예시에서의 현재 수량·목표·제작 회수는 실제 사용자 값으로 바꾸지 않는다.

시안의 100회 버튼은 고정 강조였지만 준비된 패치는 **입력값에 맞는 preset만 강조**한다. invalid/37회 등 preset과 다른 값은 모두 해제한다. 수량 계산 코드 변경은 없다.

## 3. 확인 후 패치 적용

저장소 루트에서 시작한다. 실제 작업 전 `AGENTS.md`와 Git 작업 지침을 따른다.

```powershell
git status --short
& $backend -B "$handoff/check-state.py"
```

- `READY`: 준비한 8개 파일이 그대로이며 dry-run 통과. 다음 명령을 실행한다.
- `ALREADY_APPLIED`: 같은 패치를 다시 적용하지 말고 4절 검증으로 간다.
- `STOP`: 사용자 변경 또는 다른 패치와 겹친 상태다. reset·checkout·강제 덮어쓰기를 하지 않는다. 겹치는 파일과 변경을 보고한다. 이 상황은 새 판단이 필요할 수 있다.

```powershell
git apply "$handoff/apply.patch"
& $backend -B "$handoff/check-state.py"
git diff --check
git diff --stat
```

두 번째 검사 결과가 `ALREADY_APPLIED`여야 한다. `git apply`는 working tree를 수정하는 동작이다. 다음 사용자의 구현 요청을 받은 후 실행한다.

## 4. 최소 검증

```powershell
node "$handoff/check-ui.cjs"
```

이 도구는 임시 LOCALAPPDATA·DB·별도 headless Chrome을 만들고 닫는다. 운영 앱이 쓰는 포트/DB와 다르다.

확인 내용: 회차 버튼 하나씩 존재/직접 노출/기존 토글 동작, 초기화 취소 시 회차 유지, 창고·브리핑 높이, 좁은 데스크톱의 grid 행, 연금 미저장 폼의 앱 이동 취소, 제작노트 링크 3개, preset 10→37→100 선택 상태 및 맥주100회 계산, 창고/계산의 구별. OCR와 전체 스케줄러 회귀를 실행하는 검사가 아니다.

`passed:true`가 나오면 이 디자인을 이유로 전체 프로그램 회귀를 확대하지 않는다. 실패했다면 실패한 화면·동작만 확인하고 수리한다. 실패를 무시한 완료 보고는 하지 않는다. 과도한 리팩터링은 하지 않는다.

시각 확인은 갤러리의 10개 화면과 적용한 소스 화면을 비교한다. 결과 이미지는 예시 데이터다. 실제 사용자의 재고를 그 값으로 입력하지 않는다.

## 5. 실제 앱 반영을 요청받은 경우

**설치 대상은 `D:/BDO/app`이며 `D:/BDO`의 Git checkout을 설치 디렉터리처럼 덮어쓰지 않는다.** 이번 제품 변경은 frontend 8개 파일뿐이므로 새 PyInstaller 빌드가 필요 없다. 배포 도구가 현재 설치본을 후보로 복사하고 해당 8개 파일만 교체해 전체 파일 목록을 비교한다. 실행 파일과 Python/OCR는 그대로다.

```powershell
& $backend -B "$handoff/release.py" stage
```

- `stage`는 실제 앱을 변경하지 않고 후보를 준비한다. 적용 소스·기존 설치본·그림이 준비 당시 기준과 같은지 확인한다. `frontendOnly:true`, `changedFiles:8`을 확인한다.
- `release-state.json`이 이미 있으면 stage를 다시 실행하지 않는다. 파일에 적힌 경로와 마지막 완료 단계를 확인하고 이어간다. 이 파일을 지워서 재실행하지 않는다.
- `stage`가 설치본/소스 drift로 멈추면 강제로 우회하지 않는다.

그다음 앱의 기존 정상 종료 API로 종료하고 응답 중단을 확인한다. 강제 프로세스 종료는 하지 않는다. 기존에 정지된 앱이라면 종료 요청을 반복할 필요 없다.

```powershell
$origin='http://127.0.0.1:18765'
Invoke-RestMethod -Uri "$origin/api/app/shutdown" -Method Post -ContentType 'application/json' -Headers @{Origin=$origin} -Body '{}'
```

이후 순서대로 실행한다. `prepare`와 `install`은 archive와 설치 디렉터리에 쓰므로 현재 샌드박스 밖 쓰기 권한이 필요할 수 있다. 이는 사용자에게 업무 승인을 다시 물으라는 의미가 아니라 도구 실행 권한 경계다.

```powershell
& $backend -B "$handoff/release.py" prepare
& $backend -B "$handoff/release.py" install
& $backend -B "$handoff/release.py" offline
Start-Process -FilePath 'D:/BDO/BDO 실행.lnk' -WindowStyle Hidden
& $backend -B "$handoff/release.py" verify
```

`prepare`는 전체 SQLite·ROI 백업과 ZIP/테이블 해시를 확인한다. `install`은 이전 app을 archive의 previous-app으로 보존한 뒤 후보를 설치한다. 실패하면 원래 설치본을 복구한다. `offline`과 `verify`는 파일/모든 데이터 테이블/ROI를 확인한다. 실제 데이터 보존 검사는 필수다.

Windows UAC는 기존 바로가기 설정에 따라 사용자가 직접 승인해야 할 수 있다. 승인 대기라면 설치·푸시와 실행 검증을 구분해 보고하고, 사용자 승인 후 verify만 이어간다. UAC를 우회하거나 실패한 실행을 성공으로 보고하지 않는다.

**재실행 명령은 샌드박스 밖 실제 사용자 계정에서 실행한다.** Codex의 기본 샌드박스 안에서 `Start-Process`를 호출하면 앱이 `CodexSandboxOffline` 계정으로 떠서 운영 DB 접근에 실패할 수 있다. `require_escalated`로 기존 바로가기를 실행하고 프로세스 소유자가 실제 사용자 계정인지 확인한다. 정상 종료 응답 후에는 기존 앱 프로세스까지 완전히 종료된 것을 확인한 다음 실행한다. 종료 직후 바로 실행하면 단일 실행 mutex가 남아 “이미 실행 중” 안내가 뜰 수 있다. 최종 완료 기준은 `/suite-health`와 `/api/health` 모두 정상이며 `release.py verify`가 통과하는 것이다.

## 6. 커밋·푸시를 요청받은 경우

현재 브랜치 기본값은 `codex/barter-warehouse-briefing-ui-20261026`이고 준비 기준 HEAD는 `8f65257f59e460550d1496923022b5c25fcce5af`다. 현재 값을 다시 확인한다.

`manifest.json`의 8개 제품 파일 및 사용자가 요청한 이 인계 문서만 명시적으로 stage한다. 다른 변경을 임의로 포함하지 않는다. `.local`, AppData, 테스트 산출물, temp 후보, release-state, 스크린샷과 시안 생성기를 Git에 넣지 않는다. 기존 아트 3개는 이미 추적 중이다.

staged diff를 확인한 뒤 디자인 반영 커밋을 만들고 현재 브랜치를 push한다. 사용자 지시 없이 main을 병합하거나 원격 URL을 바꾸지 않는다. 원격 브랜치 해시와 HEAD가 같은지 확인한다.

완료 보고는 간단히: 전체 배경·버튼·직접 회차 조작·앱 이동·짧은 문구 적용, 좁은 UI 확인, 실제 앱 반영/데이터 보존, 커밋과 push 결과. 실제 게임/F10 검증을 했다고 말하지 않는다.

## 7. 문제가 생겼을 때 멈출 기준

새로운 시각 디자인을 다시 결정할 필요는 없다. 다음 경우만 새 판단이 필요하다: 준비한 source/설치 baseline 불일치, 사용자 변경 충돌, 계산/API/DB 변경 없이는 해결 불가능한 기능 문제. 이때 해당 사실을 구체적으로 보고하고 상위 모델 판단을 요청한다. 단순 경로 오타·줄바꿈·테스트 타이밍은 기존 근거로 수리한다.

## 다음 채팅에 넣을 지시문

> `docs/handovers/SUITE-VISUAL-FINAL.md`를 읽고 준비된 최종 디자인 패치를 적용해. 문서에 정한 최소 확인 후 실제 앱 반영과 커밋·푸시까지 진행하고 간단히 보고해. 시안을 새로 설계하거나 기능 범위를 넓히지 마.
