# SoT-081: agent-talk — 소통은 공유 로그의 store-and-forward, 책임은 claim

상태(Status): Decision
확정(Since): 2026-07-05
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

에이전트 간 원격 소통(agent-talk)은 **워크스페이스가 이미 sync하는 공유 로그 위의
store-and-forward 코디네이션 메시지**다. 배달은 태생적으로 broadcast이고(append-only
union 로그에는 단일 배달 브로커가 없다), "누가 책임지는가"는 배달층이 아니라
**소유권층에서** 결정된다: (1) task에 붙은 메시지의 책임자는 그 task를 claim한
세션이다 — 현재 살아있는 세션이든, 죽은 뒤 baton을 되잡는 미래 세션이든
(`080`의 세션-task 바인딩이 곧 메시지 라우팅이다). (2) 멤버 지정 actionable
메시지는 claim-to-act로 수렴한다 — 동시 claim은 (createdAt, eventId) 최소값의
결정론적 tiebreak로 단일 승자가 남는다. 메시지는 툴콜 관찰과 **독립인 신규 이벤트
종류**이되 happening(단기) 레이어의 일원으로, 소비자(consolidation 입력·live
표면화·sync)는 observation의 것을 그대로 재사용한다. raw 메시지는 searchable
엔티티가 아니고(캡처 결정 ④ 상속), 그 안의 지속 지식은 consolidation이 memory로
추출하며, 추출된 raw는 기존 GC 규율로 회수 가능하다. 주소와 intent
(informational/actionable)의 선택은 **발신 에이전트의 책임**이다 — 시스템이
보장하는 것은 그 선택이 주어졌을 때의 수렴이다.

## 근거 (Why)

- **broadcast는 선택이 아니라 아키텍처의 귀결이다**: union sync(`030`)에서 이벤트는
  모든 replica에 도달한다. "정확히 한 세션에게"를 배달층에서 흉내내려면 중앙 브로커가
  필요한데 그건 local-first를 깬다. 따라서 단일 책임은 claim 이벤트(그 자체가
  전파되는)로만 수렴시킬 수 있다 — tombstone이 행삭제를 대체하는 것(`050`)과 같은
  구조의 논리다.
- **지배적 사용례의 수신자는 이미 결정적이다**: 조율·건의는 "그 task를 하는 세션"
  에게 간다. `080`이 만든 task claim(start→in_progress + 세션 바인딩)이 그 결정성을
  이미 제공하므로, task-scoped 메시지에 별도 claim 경쟁을 만드는 것은 중복이다.
- **presence 비의존**: store-and-forward는 대상이 오프라인이어도 다음 pull/세션에
  배달한다. 결정성이 살아있는 프로세스가 아니라 task 소유권의 시간축을 따르므로,
  heartbeat presence(별도 task)는 v1의 선행이 아니라 후속 강화(lease-expiry)다.
- **지식 유실 없음**: 채팅에 SoT급 내용이 흘러도 consolidation 입력에 포함되므로
  durable 지식은 memory로 추출된다. 반대로 raw를 직접 인덱싱하면 코디네이션 잡담이
  장기 기억을 오염시킨다 — 기각.
- **기각한 대안**: (1) observation의 새 signal로 편입 — Observation 엔티티에
  주소·claim이 없어 오염됨; 층위는 공유하되 이벤트 종류는 분리. (2) live 세션 id
  직접 지정 — presence 선행 필요, v1 범위 증가. (3) propose-accept 2단계 재사용 —
  조율 메시지에 과함; fire-and-forget + 선택적 claim이 맞음. (4) 팀 채팅 —
  realtime·UX 범위 폭발.

## 함의 (Implications)

- 메시지·claim은 신규 이벤트 종류로 append하고 Hub/relay는 건드리지 않는다
  (payload-opaque, `031`). 전달은 인라인 push(`042`) + 워처 케이던스(`043`)가
  전부다 — realtime은 `900`의 M5 게이트를 그대로 따른다.
- raw 메시지를 FTS에 인덱싱하지 마라. consolidation 입력에는 넣어라. consolidated
  후의 raw는 GC 대상이다.
- 메시지를 decision 엔티티로 자동 승격하지 마라 — 결정은 의도적 기록으로만.
- actionable claim의 동시성은 tiebreak로 수렴하되, 진 쪽이 양보하는 로직은
  클라이언트 판정이다(서버 조정 없음).
- `blocked`/`unblock` 동사(`900`의 연기 항목)는 이 채널 착지로 언블록된다 — block
  사유는 task-scoped informational 메시지로 전달한다.
- AGENT_GUIDE는 발신 규율을 명문화한다: task 얘기는 task에 붙이고, 단일 처리
  필요시 actionable로.

## 경계 (Boundaries)

- lease-expiry(죽은 claimer 자동 회수)는 이 문서가 정하지 않는다 — presence 정착
  후의 후속 결정. v1의 회수는 task baton 되잡기(`080`)로 충분하다.
- 위임(제안-수락으로 task를 만드는 것)은 `041` 소관 — agent-talk는 task를 만들지
  않는 소통이다. 두 채널의 통합 여부는 미결로 두지 않는다: 별개다.
- **기밀성은 없다**: 배달층이 broadcast이므로 `--to` 지정 메시지도 워크스페이스
  멤버 전원에게 보인다 — `--to`는 라우팅·표면화 힌트다. 가시성·보안은 `040`/`070`
  의 기존 입장 그대로이며, 비공개 DM은 이 문서가 정하지 않는다(필요시 별도 결정).
- 사람의 참여는 같은 채널을 CLI로 읽고 쓰는 것 — 별도 사람용 표면은 이 문서 밖.
- 상세 스키마·CLI 표면은 스펙(docs/superpowers/specs/2026-07-05-agent-talk-design.md)
  소관.

## 관련 (Related)

[[030-sync-and-merge]], [[041-cross-project-delegation]], [[042-delegation-delivery-and-watcher]], [[043-mid-session-sync-cadence]], [[050-deletion-and-revert]], [[080-task-lifecycle]], [[900-open-decisions]]
