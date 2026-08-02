# SoT-043: mid-session sync 케이던스는 워처 틱의 pull+push다 ("watcher sync")

상태(Status): Decision
확정(Since): 2026-07-03
대체함(Supersedes): — ([[042-delegation-delivery-and-watcher]]가 후속 결정으로 남긴
"송신 절반의 배경 케이던스"를 확정한다; 042 자체는 유효)
대체됨(Superseded-by): —

## 진술 (Statement)

[[042-delegation-delivery-and-watcher]]의 세션-묶인 워처는 **pull만이 아니라
watermark-gated push도 같은 틱에서 수행**한다. 즉 sync의 mid-session 케이던스는
워처 폴 주기(기본 ~30초) 하나로 통일되며, 이 주기 동작 전체의 이름은
**"watcher sync"**다 — push/pull은 그 아래의 방향 용어로 유지하고(기존
`autoPush`/`autoPull` 그대로), 케이던스 층위에 새 연산 이름을 만들지 않는다.
"heartbeat sync"라는 명명은 금지한다: `session.heartbeat`는 별개의 세션 생존
신호이며, 워처는 그 신호의 **소비자**(수명 판정)이지 그 이름의 주인이 아니다.

push 틱은 **유휴 게이트**를 지킨다: 로컬 head가 push watermark
(`lastPushedEventId`)와 같거나, 그 이후 델타가 전부 foreign-lane(pull로 받은)
이벤트면 네트워크를 타지 않는다. 따라서 아무 일도 없는 틱의 비용은 pull 프로브
HTTP 왕복 정확히 한 번이다.

## 근거 (Why)

- **경계-전용 push의 공백**: 캡처 이벤트(관찰, 체크포인트, 태스크 상태, 중간
  consolidate 메모리)는 PostCompact/SessionEnd에서만 올라갔다 — 긴 세션 동안
  다른 머신은 이쪽 작업을 전혀 못 본다. 042가 위임 커맨드의 인라인 push로 푼 것을
  일반 이벤트로 확장하는 가장 싼 자리가 이미 돌고 있는 워처 루프다: 수명 관리
  신규 비용이 0이고, per-turn 금지 규칙을 건드리지 않는다.
- **종단 지연이 대칭이 된다**: 양쪽 머신 모두 워처가 돌면 "내 push(≤30초) +
  상대 pull(≤30초)"로 일반 이벤트도 ~1분 내 전파된다. 크래시 시 잃는 것은
  마지막 폴 주기 이내의 **원격 전파 지연**뿐이다(로컬 로그는 무손실).
- **pull로 받은 이벤트를 곧장 되밀지 않는다**: head는 pull로도 전진하므로 순진한
  head 비교는 매 수신 직후 무의미한 push를 만든다. Hub union이 event id로
  dedup하니 무해하지만, self-lane 델타 검사(로컬 DB 읽기)로 그 왕복 자체를
  없앤다.
- **기각한 대안**: (1) heartbeat CLI 미들웨어에서 스로틀 push — 에이전트가
  memorize 커맨드를 안 부르면 케이던스가 죽고, pull은 아예 못 얻는다.
  (2) per-turn 훅 push — rc.0-4에서 확정한 per-turn 규칙 재론이라 기각.

## 함의 (Implications)

- SessionEnd의 인라인 최종 push는 불필요해졌다(이미 detached consolidate 자식의
  push + 워처 틱이 감당). 훅은 로컬 작업만 하고 즉시 반환한다 — 종료 시
  "SessionEnd hook failed: Hook cancelled" 표기의 원인이 이것이었다.
- 워처 수명 판정은 reap 스윕과 **같은 staleness 임계값**을 쓴다
  (`MEMORIZE_STALE_SESSION_MS`, 기본 30분) — "세션이 죽었다"의 의미는 하나여야
  한다. paused/completed/abandoned 세션은 즉시 앵커에서 제외되므로, 에이전트
  종료 후 워처는 한 폴 주기 안에 스스로 내려간다.
- 워처 자신은 heartbeat를 절대 쏘지 않는다(`SESSION_MANAGING_COMMANDS`):
  자기가 폴링하는 생존 신호를 자기가 만들면 영원히 산다.
- 튜닝 표면: `MEMORIZE_WATCHER_POLL_MS`(기본 30000),
  `MEMORIZE_WATCHER_DISABLED=1`(테스트/옵트아웃). 폴 주기가 부족해지면 SSE 등
  실시간 전송은 042의 규정대로 **그 문서를 대체하는 문서로만** 도입한다.
- 프로세스 수명 코드의 최종 게이트는 3-OS CI다(042와 동일) — 로컬 green은
  증거가 아니다.

## 경계 (Boundaries)

- 위임의 의미론과 전달 시점 자체는 [[041-cross-project-delegation]] /
  [[042-delegation-delivery-and-watcher]] 소관 — 이 문서는 일반 이벤트의 배경
  케이던스와 용어만 정한다.
- 인바운드 이벤트의 mid-session **표면화**(마커 파일을 어느 훅이 어떤 문구로
  읽는가)는 여전히 구현 소관이다(042와 동일). 워처는 마커를 쓸 뿐이다.
- transport 자체는 [[031-canonical-remote-transport]] 소관.

## 관련 (Related)

[[042-delegation-delivery-and-watcher]], [[030-sync-and-merge]], [[031-canonical-remote-transport]]
