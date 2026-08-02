# SoT-900: 미결 · 연기 결정

상태(Status): Open
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

2026-07-01 패스에서 8개 결정(#1~#8)을 확정해 대부분 home 문서로 옮겼다. 여기 남는 것은
(A) **결정됐으나 빌드가 연기**된 것, (B) 그 빌드 **착수 시 선결**할 진짜 미결, (C) 별도
트랙뿐이다.

## A. 결정 · 연기 (decided, build later)

- **순수 클라우드(zero-local) 모드** — **(C) 하이브리드로 확정**(`060`): 지원하되 기본
  아님, Hub 하류로 연기. 착수 시 store-provider seam을 먼저 심는다(공유-검색과 공유).
- **E2E** — **연기 · 수요-gated 확정**(`070`): v1은 #3(at-rest + 접근제어). 트리거는
  (SaaS 척추 완성 후 + zero-knowledge 수요). 의도된 형태는 아래 B.
- **Hub push로 워처 폴 하한 제거** — **연기 · M5 검증-gated 확정**(2026-07-04).
  [[042-delegation-delivery-and-watcher]]/[[043-mid-session-sync-cadence]]가 "폴 주기
  부족해질 때 대체 문서로만 도입"으로 미룬 realtime을, Hub 쪽 **long-poll(hanging GET)
  이벤트-가용성 엔드포인트**로 구현하기로 형태 확정(SSE 아님 — 소비자가 Node CLI 워처).
  주 설계는 Hub 레포(memorize_hub `H900`; 착수 시 신규 H-doc). 이 문서 짝: 착수 시
  **SoT-044가 042를 supersede**(폴 대신 구독 케이던스). 착수 게이트 = M5 검증이 ~30초
  수렴을 실사용에 부족하다고 실측. 트래킹 = memorize `task_mr52rm62_b7jgo7tf`.
- **`blocked`/`unblock` CLI 동사** — **연기 · agent-talk(원격 소통) 선행 확정**(`080`,
  2026-07-04). `in_progress` 슬라이스(`start`가 `in_progress`로 도달, 엄격
  `handoff`, `in_progress → done`)는 [[080-task-lifecycle]]로 확정되어 랜딩됐다.
  상태기계엔 `blocked` 전이가 정의만 있고 아직 도달하는 CLI 동사가 없다 — `blocked`/
  `unblock`은 별도 슬라이스로 미룬다. 착수 게이트 = agent-talk(다른 세션/에이전트에
  "왜 막혔는지"를 알리는 원격 소통 채널) 정착. 그 채널 없이 상태만 `blocked`로 두면
  막힌 이유가 신호로 전달되지 않는다. agent-talk의 설계는 [[081-agent-talk]]로
  확정됐다(2026-07-05) — 게이트는 그 구현 착지다.

## B. E2E 의도된 형태 + 착수 시 선결 (open)

기존 수동 `--encryption-key` primitive(#2)의 대칭 키가 곧 store별 **데이터 키(DEK)**이고,
그 위에 배포 계층만 얹는다:

- **envelope encryption(키 래핑)** + **device-keypair 등록**.
- 기기 식별 = 기기가 생성한 **키쌍의 public key**(MAC 주소 아님 — 위조 trivial + 랜덤화로
  불안정). private key는 기기 보안 저장소를 절대 안 떠난다.
- DEK를 각 등록 기기의 public key로 **래핑**해 보관. 새 기기 등록 = 기존 기기/복구 흐름이
  DEK를 새 public key로 래핑해 전달.
- 서버엔 **래핑된 DEK + public key만**, 평문 DEK·private key는 **절대 안 올라감**.
- **착수 시 선결 = 복구 정책 (진짜 미결)**: 단일 기기 분실 시 영구 소실. (a) 오프라인
  복구 키 / (b) 서버 매개 복구(E2E 약화) / (c) 다중 기기 상호 복구 중 택1을 빌드 *전*에
  못박아야 한다 — "맥락을 잃지 않는다"가 가치라 나중에 끼워넣을 수 없다.

## C. 캡처-층 확장 (별도 트랙)

"캡처되면 기본 공유"(`040`)라 캡처를 늘리면 공유도 자동으로 따라온다. 실시간 파일-터치 등
**더 세밀한 시그널 캡처**는 공유 정책과 독립한 캡처-층 기능이며, 별도로 진행한다.

## D. 에이전트 능동 제안: 파생 태스크 라이프사이클 (open)

**등록(Since): 2026-07-04.**

관찰: "다른 세션에서 진행중이지 않은 task 하나를 잡아"만으로 세션 착수는 잘 되지만, task
*중간*에 (a) 다른 프로젝트로의 task request(위임), (b) 후속 task 생성, (c) 새 아이디어의
task 등록 같은 파생이 생겨야 태스크 체인이 끊기지 않고 이어진다. 지금은 에이전트가 이걸
능동적으로 제안하지 않아 라이프사이클이 사용자 기억에 의존한다.

- **자리 = 제품으로 확정, 개인 기억 아님.** 이 행동은 사용자 취향이 아니라 memorize가
  태스크 라이프사이클을 굴리는 일반 속성이므로, 그라운드룰("프로젝트 상태는 memorize가
  단일 진실")에 따라 제품에 있어야 모든 에이전트·세션에 적용된다. 개인 메모리는 per-self라
  나의 세션에서만, 그것도 세션-메모리 게이트가 꺼진 지금은 자동 주입도 안 돼 조용히 낡는다.
- **진짜 미결 = 트리거 시점.** 너무 자주 제안하면 잔소리, 너무 드물면 무의미. 언제 넛지를
  띄울지가 안 정해졌다. 이걸 코드/주입문구로 바로 박으면 되돌리기 비싸므로, 트리거가 실사용
  으로 잡히기 *전*에는 착수하지 않는다(dogfood-first).
- **의도된 형태(착수 시).** 두 층: (1) 에이전트 가이드 문구 — "task 진행 중 파생/위임
  필요를 감지하면 사용자에게 등록을 제안하라" — 를 memorize 주입 컨텍스트/AGENT_GUIDE에.
  (2) 선택적 넛지 메커니즘 — `task resume` 등 명령 출력 말미에 "이 작업에서 후속/위임
  태스크가 나왔나?"를 가볍게 리마인드. 위임 경로는 [[041-cross-project-delegation]]의
  제안-수락 모델을 재사용한다.
- **착수 게이트 = 트리거 튜닝 완료.** 어느 순간이 유용/성가신지 실사용으로 관측한 뒤 형태를
  확정하고 제품(주입 가이드 → 필요 시 넛지 훅)으로 승격한다.

## 닫힌 결정 (이 문서에서 이동)

#1 raw+consolidated 층상(`040`/`050`) · #2 2역할 권한(`040`/`050`) · #3 raw 기본포함
+팀 opt-out(`040`) · #5 계정 purge 옵션(`010`/`020`) · #6 git 비가정·이질적 워크스페이스
(`020`) · #8 void(로컬 통합 메모리에선 무의미, #4에 흡수).

## 관련 (Related)

[[040-workspace-sharing-and-capacity]], [[041-cross-project-delegation]], [[042-delegation-delivery-and-watcher]], [[043-mid-session-sync-cadence]], [[050-deletion-and-revert]], [[060-storage-locality-and-retrieval]], [[070-security-stance]]
