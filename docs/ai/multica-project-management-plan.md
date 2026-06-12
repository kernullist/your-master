# AIRI 로컬 AI 개발팀 오케스트레이터 구현 계획

## 목표

이 문서는 AIRI에 `https://github.com/multica-ai/multica`의 멀티 에이전트 기반 프로젝트 관리 경험을 AIRI 방식으로 이식하기 위한 단계별 구현 계획이다.

단순한 칸반 보드가 아니라, **AIRI가 사용자와 대화하는 메인 AI가 되고, 별도의 워커 코딩 에이전트와 리뷰 에이전트를 로컬 프로젝트에 투입해 일감을 처리하는 로컬 AI 개발팀 시스템**을 목표로 한다.

목표 사용자 경험:

- 사용자는 AIRI 채팅으로 프로젝트와 일감 상태를 확인한다.
- 사용자는 AIRI 채팅으로 새 일감을 등록하고, 목표와 완료 조건을 정리한다.
- AIRI는 일감을 워커 에이전트에게 맡기고, 리뷰어 에이전트에게 검토를 맡긴다.
- 사용자는 AIRI에게 요청해 브라우저에서 `localhost` 기반 칸반 보드를 열 수 있다.
- 평소에는 AIRI 채팅창에서 짧은 상태 변경 알림만 받는다.
- 리뷰 통과 후 설정에 따라 자동 커밋하거나 사용자 승인을 기다린다.

분석 기준:

- AIRI 로컬 저장소: `F:\kernullist\your-master`
- Multica 기준 저장소: `https://github.com/multica-ai/multica`
- Multica 분석 커밋: `18524d8`

## 확정된 MVP 요구사항

### 범위

- 첫 버전은 로컬 전용이다.
- 별도 보드 UI는 Electron 내부 창이 아니라 브라우저에서 여는 독립 `localhost` 웹 UI다.
- AIRI 앱이 실행 중일 때만 내장 로컬 서버가 켜진다.
- 로컬 보드 접근에 랜덤 토큰은 붙이지 않는다.
- 한 번에 하나의 프로젝트, 하나의 일감만 처리한다.
- drag/drop은 첫 버전에 포함하지 않는다.

### 프로젝트 등록

- 사용자는 별도 로컬 프로젝트 폴더를 등록할 수 있다.
- 등록 시 폴더명을 프로젝트 이름으로 사용한다.
- 등록 시 사용자가 일감 번호 prefix를 직접 입력한다.
- prefix는 추천하지 않는다.
- 프로젝트별 모델 설정은 없다. AIRI 전역 설정의 AIRI/워커/리뷰어 모델을 사용한다.
- git 저장소가 아닌 폴더도 등록 가능하다.
- git 저장소가 아니면 자동 commit/revert 기능은 비활성화한다.

### 일감 등록

- 일감 번호는 프로젝트 prefix 기준으로 자동 증가한다. 예: `BC-1`, `BC-2`.
- 사용자가 일감 번호를 직접 입력할 수도 있다.
- 직접 입력한 번호가 중복되면 AIRI가 사용자에게 확인을 요청한다.
- AIRI는 일감 생성 과정에서 `목표`와 `완료 조건`을 질문해서 채운다.
- 커밋 메시지는 일감 번호를 포함한다. 예: `feat: add project board (AIRI-12)`.
- 일감에는 선택적인 커밋 로그 prefix를 설정할 수 있다.
- 커밋 로그 prefix가 있으면 자동 커밋 메시지 맨 앞에 붙인다. 예: `AC-781 [feat] add project board (BC-1)`.

### 에이전트 모델

- AIRI는 사용자와 대화하고 전체 작업을 관리하는 메인 AI다.
- 워커 에이전트는 실제 개발/수정 작업을 수행한다.
- 리뷰 에이전트는 요구사항 충족 여부와 명백한 버그를 중심으로 검토한다.
- 에이전트는 외부 CLI가 아니라 API 호출 기반으로 직접 구현한다.
- 모델 백엔드는 LM Studio, Ollama, OpenRouter, Codex CLI를 지원한다.
- AIRI 모델, 워커 모델, 리뷰어 모델을 각각 설정할 수 있다.

### 작업 실행

- 워커는 등록된 원본 프로젝트 폴더를 직접 수정하지 않고, 일감별 git worktree에서 파일을 수정한다.
- git worktree는 원본 프로젝트의 형제 경로 `.airi-worktrees/<프로젝트명>/<일감번호>` 아래에 만든다.
- worktree는 일감별 브랜치 `airi/work/<일감번호>`를 checkout한다.
- 원본 프로젝트 폴더에 dirty worktree가 있으면 AIRI가 변경 파일 목록을 보여주고, 사용자 확인 후 worktree를 만든다.
- 워커는 AIRI 내부 tool set을 사용해 파일을 읽고, 검색하고, patch를 적용한다.
- shell 실행은 allowlist 안에서 허용한다.
- 기본 정책은 대부분의 명령을 허용하되, `rm`, `del`, `git reset`, `git clean` 같은 파괴적 명령은 금지한다.
- 금지 명령이 필요하면 AIRI가 멈추고 사용자 확인을 요청한다.

### 테스트와 리뷰

- AIRI가 `package.json`, `pnpm`, `cargo`, `go test` 등을 분석해 테스트/빌드 명령을 추천한다.
- 테스트 명령 추천에 실패하면 AIRI가 사용자에게 설정을 요청한다.
- 테스트 가능한 경우 실행하고 결과를 기록한다.
- 테스트 실패는 기록하되, 리뷰어가 통과 판단하면 완료 가능하다.
- 리뷰어가 수정 필요로 판단하면 리뷰 코멘트 전체와 diff를 워커에게 넘겨 자동 재시도한다.
- 자동 재시도는 최대 5회다.
- 5회 후에도 실패하면 에이전트 worktree를 정리하고 일감을 `blocked`로 바꾼다.

### 상태 흐름

기본 흐름:

- `todo` -> `in_progress` -> `in_review` -> `done`

예외 흐름:

- 리뷰 수정 필요: `in_review` -> `in_progress`
- 실패: `blocked`
- 하지 않기로 한 일감: 상태 변경 대신 삭제

의미:

- 워커 에이전트가 개발/수정 중이면 `in_progress`.
- 리뷰 에이전트가 리뷰 중이면 `in_review`.
- 리뷰 통과 후 커밋까지 완료되면 `done`.
- 리뷰는 통과했지만 커밋이 실패하면 `done`을 유지하고 "커밋 실패" 코멘트를 기록한다.
- `cancelled` 상태는 두지 않는다. 필요 없어진 일감은 삭제한다.

### 커밋과 revert

- 리뷰 통과 후 자동 커밋이 기본값이다.
- AIRI 설정으로 최종 승인 후 커밋 모드도 선택할 수 있다.
- 자동 커밋은 일감별 worktree 브랜치에서 수행한다.
- 자동 커밋 시 에이전트가 만든 변경 파일만 stage한다.
- 원본 프로젝트 폴더의 다른 변경사항은 stage하지 않는다.
- 여러 에이전트가 동시에 완료되면 원본 프로젝트별 통합 lock으로 completed branch를 하나씩 cherry-pick한다.
- 동일 변경이 이미 반영되어 empty cherry-pick이 발생하면 충돌이 아니라 성공한 skipped integration으로 처리한다.
- 원본 dirty 상태나 cherry-pick 충돌로 자동 통합하지 못하면 branch와 worktree를 보존하고 일감을 `blocked`로 표시한다.
- 자동 revert는 원본 폴더를 건드리지 않고 일감 worktree를 정리하는 방식으로 처리한다.
- 비-git 프로젝트에서는 commit/revert가 필요한 순간 AIRI가 사용자에게 알린다.

### 사용자 알림과 로그

- AIRI 채팅 알림은 짧은 상태 변경 중심으로 한다.
- 예: `AIRI-12가 리뷰중으로 변경됐어.`
- 예: `AIRI-12가 완료됐고 커밋했어: feat: add project board (AIRI-12)`
- 일감에는 전체 로그 대신 diff 요약, 워커 코멘트, 리뷰어 코멘트, 리뷰 결과를 간단히 저장한다.

## Multica에서 가져올 핵심 개념

Multica는 "Linear 같은 이슈/프로젝트 관리 + 에이전트를 1급 팀원으로 다루는 실행 플랫폼"에 가깝다. AIRI에 그대로 포팅할 대상은 React/Next.js UI나 Go 서버가 아니라, 도메인 모델과 작업 흐름이다.

가져올 개념:

- `project`: 제목, 설명, 상태, 일감 진행률을 가진 컨테이너.
- `issue`: 상태, 프로젝트, 위치, 댓글, 활동 기록을 가진 일감.
- `agent`: 모델, 지시문, 상태, 동시성, 권한을 가진 실행자.
- `agent_task_queue`: 에이전트와 일감 실행을 연결하는 큐.
- `chat_session`, `chat_message`: AIRI가 일감 생성/수정/상태 알림을 주고받는 대화 표면.
- 실시간 이벤트: 일감 상태, 코멘트, 실행 결과 변경을 보드와 채팅에 전파한다.

Multica에서 확인한 주요 파일:

- `packages/core/types/issue.ts`
- `packages/core/types/project.ts`
- `packages/core/types/agent.ts`
- `packages/core/types/chat.ts`
- `server/migrations/001_init.up.sql`
- `server/migrations/033_chat.up.sql`
- `server/migrations/034_projects.up.sql`
- `server/internal/handler/issue.go`
- `server/internal/handler/project.go`
- `server/internal/handler/chat.go`
- `server/internal/service/task.go`
- `packages/views/issues/components/board-view.tsx`
- `packages/views/issues/components/board-column.tsx`
- `packages/views/issues/components/board-card.tsx`

## AIRI에서 활용할 통합 지점

AIRI에는 이 기능을 끼워 넣을 좋은 지점이 이미 있다.

- 채팅 오케스트레이션: `packages/stage-ui/src/stores/chat.ts`
- 런타임 LLM 도구 병합: `packages/stage-ui/src/stores/llm-tools.ts`
- 데스크톱 채팅 창 간 동기화: `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts`
- 기존 내장 채팅 도구 위치: `apps/stage-tamagotchi/src/renderer/stores/tools/builtin`
- Electron IPC/Eventa 계약 위치: `apps/stage-tamagotchi/src/shared/eventa/index.ts`
- main-process DI 조립: `apps/stage-tamagotchi/src/main/index.ts`
- 내장 HTTP 서버: `apps/stage-tamagotchi/src/main/services/airi/http-server`
- 서버 런타임 패키지: `packages/server-runtime`

권장 방향은 Multica 코드를 직접 가져오는 것이 아니라, AIRI 네이티브 패키지/서비스를 만들고 그것을 채팅 도구, 로컬 실행 런타임, localhost 보드 UI에 연결하는 것이다.

## 제품 모델

사용자에게 보이는 핵심 모델:

- 프로젝트: 등록된 로컬 폴더.
- 일감: 사용자가 AIRI에게 맡기는 작업 단위.
- 보드: 상태별 칸반 뷰.
- AIRI: 사용자와 대화하는 관리자.
- 워커 에이전트: 파일 수정과 테스트 수행자.
- 리뷰 에이전트: 요구사항 충족과 버그 여부 검토자.

일감 상태:

- `todo`
- `in_progress`
- `in_review`
- `done`
- `blocked`

채팅 MVP 액션:

- 프로젝트 등록.
- 프로젝트 목록 보기.
- 일감 등록.
- 일감 상태 확인.
- 일감 실행 시작.
- 일감 삭제.
- 보드 열기.
- 워커/리뷰어 설정 확인.
- 작업 결과 요약 확인.

## 권장 아키텍처

### 1. 공유 도메인 패키지

새 패키지 `packages/stage-projects`를 만든다.

역할:

- 프로젝트/일감/댓글/실행 기록/에이전트 설정 타입 정의.
- Valibot 스키마 정의.
- 로컬 API 클라이언트와 런타임 어댑터 정의.
- Pinia store 또는 composable에서 재사용할 순수 헬퍼 제공.
- 보드 그룹핑, 상태 순서, 일감 식별자, 요약 생성 로직 제공.

예상 구조:

- `src/types/project.ts`
- `src/types/work-item.ts`
- `src/types/work-item-comment.ts`
- `src/types/agent-config.ts`
- `src/types/run-record.ts`
- `src/schemas/project.ts`
- `src/schemas/work-item.ts`
- `src/schemas/agent-config.ts`
- `src/api/client.ts`
- `src/stores/projects.ts`
- `src/stores/work-items.ts`
- `src/utils/board.ts`
- `src/utils/identifiers.ts`

이 패키지는 UI를 포함하지 않는다. 보드 웹 UI, 채팅 도구, main-process service가 같은 도메인 타입을 공유하도록 한다.

### 2. 로컬 프로젝트 관리 서비스

새 main-process service를 만든다.

- `apps/stage-tamagotchi/src/main/services/airi/project-management/index.ts`

역할:

- 프로젝트 등록/조회/삭제.
- 일감 CRUD.
- 일감 번호 중복 확인과 사용자 확인 요청 연계.
- 일감 상태 변경.
- 일감 댓글과 diff/review 요약 저장.
- 로컬 저장소 관리.
- 변경 시 Eventa 이벤트 발행.

저장 방식:

- 첫 버전은 기존 Electron persistence helper 기반 JSON 저장소를 우선 고려한다.
- 구조가 커지면 SQLite/Drizzle로 옮긴다.
- 첫 버전은 로컬 전용이므로 `apps/server` 동기화는 포함하지 않는다.

### 3. 로컬 실행 런타임

새 실행 서비스가 필요하다.

- `apps/stage-tamagotchi/src/main/services/airi/project-runner/index.ts`

역할:

- 한 번에 하나의 일감만 실행하도록 전역 lock 관리.
- dirty worktree 검사.
- 작업 시작 baseline 기록.
- 워커 에이전트 실행.
- 테스트 명령 추천과 실행.
- 리뷰 에이전트 실행.
- 리뷰 실패 시 최대 5회 재시도.
- 실패 시 에이전트 변경 파일 revert.
- 리뷰 통과 시 에이전트 변경 파일만 stage하고 commit.
- 상태 변경을 project-management service에 기록.

### 4. 에이전트 API 런타임

외부 CLI가 아니라 API 호출 기반으로 구현한다.

새 모듈 후보:

- `packages/stage-projects/src/agents/model-runtime.ts`
- `apps/stage-tamagotchi/src/main/services/airi/project-runner/agents.ts`

지원 provider:

- LM Studio
- Ollama
- OpenRouter
- Codex CLI (`codex debug models`로 사용 가능 모델을 조회하고 `codex exec`로 실행)

전역 설정:

- AIRI 모델.
- 워커 에이전트 모델.
- 리뷰 에이전트 모델.
- 워커 시스템 프롬프트.
- 리뷰어 시스템 프롬프트.
- timeout.
- shell command denylist/allowlist.
- 자동 커밋 여부.

### 5. 워커 tool set

워커 에이전트는 작은 내부 tool set으로만 프로젝트를 수정한다.

필수 도구:

- `project_read_file`
- `project_search_files`
- `project_apply_patch`
- `project_list_files`
- `project_run_shell`
- `project_git_status`
- `project_git_diff`

권한 정책:

- 모든 도구는 등록된 프로젝트 루트 안에서만 작동한다.
- 금지 파일/경로 패턴을 검사한다.
- shell 명령은 기본적으로 허용하되 파괴적 명령은 denylist로 막는다.
- `rm`, `del`, `git reset`, `git clean` 등은 기본 금지한다.
- 금지 명령이 필요하면 AIRI가 사용자에게 확인을 요청한다.

### 6. Eventa 계약

Electron main/renderer 사이의 계약은 공유 모듈에 둔다.

새 파일 후보:

- `apps/stage-tamagotchi/src/shared/eventa/project-management.ts`

계약 후보:

- `electronProjectRegister`
- `electronProjectList`
- `electronProjectGet`
- `electronProjectDelete`
- `electronWorkItemList`
- `electronWorkItemGet`
- `electronWorkItemCreate`
- `electronWorkItemUpdate`
- `electronWorkItemCommentList`
- `electronWorkItemCommentCreate`
- `electronWorkItemStart`
- `electronWorkItemCancel`
- `electronOpenProjectBoard`
- `projectManagementChanged`
- `projectRunnerStateChanged`

핸들러는 main service에서 등록하고, `apps/stage-tamagotchi/src/main/index.ts`의 `injeca` 조립에 연결한다.

### 7. AIRI 채팅 도구

프로젝트 관리와 일감 실행 기능은 AIRI 채팅에서 LLM tool로 노출한다.

새 파일 후보:

- `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/project-management.ts`

도구 이름 후보:

- `stage_project_register`
- `stage_projects_list`
- `stage_work_items_list`
- `stage_work_item_create`
- `stage_work_item_update`
- `stage_work_item_start`
- `stage_work_item_cancel`
- `stage_project_board_open`

구현 규칙:

- JSON Schema는 provider 호환성을 위해 명시적인 `type: object`와 `required`를 둔다.
- 일감 생성 도구는 `identifier`, `title`, `goal`, `acceptanceCriteria`를 받는다.
- update/start/delete 계열 도구는 안정적인 일감 id 또는 identifier를 받는다.
- 도구 응답은 사람이 읽을 수 있는 요약과 구조화 데이터를 함께 반환한다.
- 상태 변경 알림은 짧게 유지한다.

### 8. localhost 보드 웹 UI

보드는 Electron 내부 창이 아니라 브라우저에서 여는 로컬 웹 UI다.

권장 route:

- `http://localhost:<port>/project-board`

구현 방향:

- AIRI 내장 HTTP 서버에 보드 route를 추가한다.
- 보드 UI는 Vue로 구현한다.
- 첫 버전은 drag/drop 없이 상태 컬럼, 카드, 상세 패널, 댓글, 실행 버튼을 제공한다.
- 보드 서버는 AIRI 앱 실행 중에만 켜진다.
- localhost 보드 접근 토큰은 사용하지 않는다.

컴포넌트 맵:

- `ProjectBoardPage.vue`: route-level composition.
- `ProjectBoardToolbar.vue`: 프로젝트 정보, 필터, 새 일감 버튼.
- `KanbanBoard.vue`: 상태 컬럼 구성.
- `KanbanColumn.vue`: 상태별 일감 목록.
- `WorkItemCard.vue`: identifier, 제목, 상태, 마지막 코멘트.
- `WorkItemDetailPanel.vue`: 목표, 완료 조건, diff 요약, 워커/리뷰어 코멘트.
- `CreateWorkItemDialog.vue`: identifier, 제목, 목표, 완료 조건 입력.

배치 후보:

- 공유 컴포넌트: `packages/stage-ui/src/components/scenarios/project-management`
- 보드 페이지: `packages/stage-pages/src/pages/project-management/board.vue`
- localhost route entry: `apps/stage-tamagotchi`의 내장 서버 또는 renderer build route

## 단계별 구현 계획

### Phase 0. 요구사항 확정

완료됨. 이 문서의 "확정된 MVP 요구사항"을 기준으로 구현한다.

산출물:

- 로컬 전용 AI 개발팀 오케스트레이터 요구사항.
- 한 번에 하나의 프로젝트/일감만 처리하는 MVP 제약.
- AIRI/워커/리뷰어 모델 분리.
- 워커 tool set, 리뷰 루프, 자동 commit/revert 정책.

### Phase 1. 도메인 기반 만들기

`packages/stage-projects`를 만든다.

구현:

- `Project`, `WorkItem`, `WorkItemComment`, `RunRecord`, `AgentModelConfig` 타입.
- 프로젝트 등록 스키마: folder path, name, prefix.
- 일감 생성 스키마: identifier, title, goal, acceptance criteria.
- 상태 순서와 상태 전이 헬퍼.
- 일감 identifier 중복 검사 헬퍼.
- 보드 그룹핑과 요약 헬퍼.
- Vitest 테스트.

산출물:

- UI, runner, 채팅 도구가 공유할 수 있는 도메인 패키지.

구현 상태:

- 완료.
- 추가 파일: `packages/stage-projects`.
- 포함 내용: 도메인 타입, Valibot 스키마, identifier 정규화/중복 검사, 보드 그룹핑/정렬, shell/path 정책 헬퍼, Vitest 테스트.
- 검증:
  - `pnpm -F @proj-airi/stage-projects typecheck`
  - `pnpm -F @proj-airi/stage-projects test:run`

### Phase 2. 로컬 저장소와 Eventa 서비스

main-process project-management service를 만든다.

구현:

- 프로젝트 등록/목록/삭제.
- 일감 CRUD.
- 댓글/실행 요약 기록.
- 상태 변경 이벤트.
- Eventa invoke handler.
- JSON persistence.
- 서비스 단위 테스트.

산출물:

- renderer와 채팅 도구가 Eventa로 프로젝트/일감 데이터를 읽고 쓸 수 있다.

구현 상태:

- 완료.
- 추가 파일:
  - `apps/stage-tamagotchi/src/shared/eventa/project-management.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-management/index.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-management/store.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-management/store.test.ts`
- 포함 내용: Electron `userData` JSON persistence, Eventa invoke/event contracts, 프로젝트 등록/삭제, 일감 생성/수정, 중복 identifier 확인, 댓글/실행 기록, 설정 저장, 상태 변경 이벤트.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/project-management/store.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 3. 프로젝트 등록과 설정 UI

사용자가 로컬 프로젝트를 등록할 수 있게 한다.

구현:

- 폴더 선택.
- 폴더명 기반 프로젝트 이름 저장.
- prefix 직접 입력.
- git 저장소 여부 감지.
- 비-git 프로젝트는 commit/revert 비활성화 표시.
- AIRI/워커/리뷰어 모델 전역 설정 화면.
- 자동 커밋 여부 설정.
- shell denylist/allowlist 설정.

산출물:

- 사용자는 프로젝트와 에이전트 모델을 설정할 수 있다.

구현 상태:

- 완료.
- 추가 파일: `apps/stage-tamagotchi/src/renderer/pages/settings/project-management.vue`.
- 포함 내용: 프로젝트 폴더/prefix 등록, 등록 프로젝트 목록/삭제, git 가능 여부 표시, Project Manager/Worker/Reviewer provider/model/base URL/API key/system prompt 설정, Codex CLI 모델 직접 조회, 자동 커밋, 리뷰 재시도 수, 타임아웃, shell allow/deny list, 금지 경로 설정.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 4. AIRI 채팅 도구 연결

LLM에서 호출 가능한 내장 도구를 만든다.

구현:

- 프로젝트 등록/목록 도구.
- 일감 등록/목록/수정 도구.
- 일감 실행/삭제 도구.
- 보드 열기 도구.
- 일감 등록 시 AIRI가 목표와 완료 조건을 질문하도록 프롬프트/도구 흐름 정리.
- 기존 built-in tool 테스트 패턴을 따른 테스트.

산출물:

- 사용자가 채팅으로 일감을 만들고 실행할 수 있다.

구현 상태:

- 완료.
- 추가 파일: `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/project-management.ts`.
- 추가 테스트: `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/project-management.test.ts`.
- 포함 내용: `stage_project_management` built-in tool, 프로젝트 등록/목록, 일감 생성/목록/상태 수정, duplicate identifier 확인 메시지, 보드 열기 액션, 기본 chat-sync tool resolver 연결.
- 추가 반영: `AIRI-12 진행해줘`처럼 일감 번호와 시작 의도가 명확한 채팅은 LLM tool call을 기다리지 않고 로컬 shortcut으로 `start_work_item`을 실행한다. 목표/완료 조건이 부족하면 시작하지 않고 AIRI가 사용자에게 다시 질문한다.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/stores/tools/builtin/project-management.test.ts src/renderer/stores/chat-sync.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 5. 워커 tool set과 runner 구현

실제 파일 수정과 명령 실행을 수행하는 runner를 만든다.

구현:

- 프로젝트 루트 제한 파일 접근.
- read/search/list/patch 도구.
- allowlist/denylist 기반 shell 실행.
- dirty worktree 검사와 사용자 확인 요청 이벤트.
- 에이전트가 만든 변경 파일 추적.
- git diff 요약 생성.

산출물:

- 워커 에이전트가 tool call 기반으로 실제 파일을 수정할 수 있다.

구현 상태:

- 완료.
- 추가 파일:
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/tools.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/tools.test.ts`
- 포함 내용: 프로젝트 루트 제한 경로 해석, forbidden path 검사, directory list, UTF-8 file read, exact replacement patch, 텍스트 검색, shell allow/deny/timeout 실행, git dirty file 검사.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/project-runner/tools.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 6. 테스트 추천과 실행

프로젝트 구조를 분석해 테스트 명령을 추천한다.

구현:

- `package.json` scripts 분석.
- pnpm/npm/yarn/bun 감지.
- Cargo/Go/Python 프로젝트 감지.
- 추천 실패 시 사용자에게 설정 요청.
- 실행 결과를 일감 코멘트에 요약 저장.

산출물:

- 가능한 경우 자동 테스트 결과가 일감에 기록된다.

구현 상태:

- 완료.
- 추가 파일:
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/tests.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/tests.test.ts`
- 포함 내용: `package.json` scripts 분석, pnpm/yarn/bun/npm 감지, Cargo/Go/Python marker 감지, 추천 실패 요약, 추천/설정 테스트 명령 실행 요약.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/project-runner/tests.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 7. 리뷰 루프와 자동 수정

리뷰어 에이전트를 실행하고 워커 재시도 루프를 만든다.

구현:

- 리뷰 입력: 요구사항, 완료 조건, diff, 테스트 결과, 워커 코멘트.
- 리뷰 출력: 통과 여부, 문제 목록, 수정 요청 코멘트.
- 실패 시 `in_review` -> `in_progress`로 되돌리고 워커 재실행.
- 최대 5회 반복.
- 최종 실패 시 에이전트 변경 파일 revert 후 `blocked`.

산출물:

- 워커/리뷰어 자동 루프가 일감 상태에 반영된다.

구현 상태:

- 완료.
- 추가 파일:
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/agent-runtime.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/orchestrator.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/review-loop.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/agent-runtime.test.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/orchestrator.test.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/review-loop.test.ts`
- 포함 내용: LM Studio/Ollama/OpenRouter OpenAI-compatible API 호출, Codex CLI 모델 조회와 read-only `codex exec` 호출, JSON action 기반 워커 tool loop, worktree 기반 실행 디렉토리 연결, worker/reviewer retry loop, reviewer feedback 재전달, 상태 전이, 워커 착수/리뷰 요청/리뷰어 착수/리뷰 결과/테스트/diff 코멘트 hook, 최대 재시도 실패 시 worktree 정리와 `blocked` 처리.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/project-runner/agent-runtime.test.ts src/main/services/airi/project-runner/review-loop.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 8. 자동 커밋

리뷰 통과 후 커밋 정책을 구현한다.

구현:

- 에이전트가 만든 변경 파일만 stage.
- 일감 번호 포함 커밋 메시지 생성.
- 자동 커밋 기본값.
- 설정에 따라 사용자 승인 후 커밋.
- 커밋 실패 시 `done` 유지 + "커밋 실패" 코멘트 기록 + 미커밋 worktree 보존.
- 자동 커밋이 꺼져 있으면 리뷰를 통과한 worktree를 삭제하지 않고 보존.
- 자동 통합 충돌 시 `blocked` + branch/worktree 보존 + 수동 통합 코멘트 기록.
- 이미 반영된 동일 patch는 empty cherry-pick을 충돌로 보지 않고 skipped success로 처리.

산출물:

- 리뷰 통과한 일감은 자동으로 커밋까지 완료된다.

구현 상태:

- 완료.
- 추가 파일:
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/git.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/project-runner/git.test.ts`
- 포함 내용: shell interpolation 없는 git 실행, 일감별 git worktree/branch 생성과 조건부 제거, 에이전트 변경 파일만 stage, 일감 번호 포함 conventional commit message 생성, short hash 반환, commit 실패 결과 객체, 미커밋 변경 보존, 원본 프로젝트별 직렬 cherry-pick 통합, empty cherry-pick 성공 처리, 통합 충돌 시 blocked 처리와 worktree 보존, 에이전트 변경 파일만 `git restore` revert, diff stat 요약.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/project-runner/git.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 9. localhost 보드 UI

브라우저에서 열 수 있는 보드 UI를 만든다.

구현:

- `http://localhost:<port>/project-board`.
- 상태별 컬럼.
- 일감 카드.
- 상세 패널.
- diff 요약과 워커/리뷰어 코멘트 표시.
- 실행/삭제 버튼.
- drag/drop 없음.

산출물:

- AIRI가 보드 URL을 열어 주고 사용자가 브라우저에서 진행 상황을 볼 수 있다.

구현 상태:

- 완료.
- 추가 파일:
  - `apps/stage-tamagotchi/src/main/services/airi/http-server/http/project-board/index.ts`
  - `apps/stage-tamagotchi/src/main/services/airi/http-server/http/project-board/index.test.ts`
- 포함 내용: `http://127.0.0.1:<port>/project-board` HTML 보드, snapshot API, runner-backed work item start API, 상태별 컬럼, 카드, 상세 패널, comment 표시, TODO 전용 Start 버튼, 일감 삭제 버튼, AIRI 채팅 `open_board` 도구의 실제 URL 조회.
- 검증:
  - `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/http-server/http/project-board/index.test.ts src/renderer/stores/tools/builtin/project-management.test.ts`
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`

### Phase 10. 검증

우선 대상 테스트:

- `pnpm exec vitest run packages/stage-projects`
- `pnpm exec vitest run apps/stage-tamagotchi/src/renderer/stores/tools/builtin/project-management.test.ts`
- `pnpm exec vitest run apps/stage-tamagotchi/src/main/services/airi/project-management`
- `pnpm exec vitest run apps/stage-tamagotchi/src/main/services/airi/project-runner`
- `pnpm -F @proj-airi/stage-tamagotchi typecheck`

최종 저장소 확인:

- `pnpm typecheck`
- `pnpm lint:fix`

## MVP 추천 순서

1. `packages/stage-projects` 도메인 패키지.
2. main-process project-management service와 JSON 저장소.
3. 프로젝트 등록/모델 설정 UI.
4. AIRI 채팅 도구.
5. 워커 tool set과 runner.
6. 테스트 추천/실행.
7. 리뷰 루프와 자동 수정/revert.
8. 자동 커밋.
9. localhost 보드 UI.

이 순서가 가장 빠르게 가치를 만든다. AIRI가 먼저 프로젝트 관리자처럼 일감을 정리하고, 다음 단계에서 워커/리뷰어를 실제로 운영하며, 마지막으로 브라우저 보드에서 상태를 볼 수 있게 된다.

## 후속 확장

MVP 이후 확장 후보:

- worktree 완료 브랜치 병합 UI와 충돌 처리.
- 여러 프로젝트/여러 일감 동시 실행.
- drag/drop 보드.
- 서버/웹 동기화.
- 프로젝트별 모델/권한 설정.
- 더 정교한 리뷰 기준과 보안 정책.
- 외부 코딩 CLI 에이전트 연동.

## 주요 리스크와 대응

- LLM이 잘못된 파일을 수정함: 모든 파일 도구는 프로젝트 루트와 금지 경로를 검사한다.
- shell 명령이 위험함: 기본 denylist로 파괴적 명령을 막고, 필요 시 사용자 확인을 받는다.
- 사용자 변경사항을 덮어씀: 원본 폴더를 직접 수정하지 않고 일감별 worktree에서 작업하며, 원본 dirty 상태는 시작 전에 파일 목록을 보여주고 확인받는다.
- 리뷰 루프가 끝없이 반복됨: 최대 5회 후 자동 revert + `blocked`.
- 비-git 프로젝트에서 복구가 어려움: commit/revert 비활성화 상태를 명확히 표시하고 필요한 순간 사용자에게 알린다.
- 테스트 실패를 과도하게 막음: 테스트 실패는 기록하되 리뷰어 판단을 우선한다.
- 커밋에 사용자 변경사항이 섞임: 에이전트가 만든 변경 파일만 stage한다.
