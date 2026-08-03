# SoT-060: 저장 위치(locality)와 검색

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

개인 / private 프로젝트 기억은 **로컬-authoritative replica**다: 오프라인 작동, 매 세션
주입, 저지연. 공유 채널도 **기본값은 로컬 replicate**다(작고 공유-의도 데이터라 0 read
레이턴시 + 오프라인). startup hot-path를 네트워크 fetch로 **절대 블로킹하지 않는다** —
공유는 additive·best-effort이며 오프라인에서 우아하게 degrade한다. 검색의 최종 selection은
항상 클라이언트에서 한다.

## 근거 (Why)

개인 기억은 매 호출 임계경로에 있어 네트워크 왕복을 얹으면 모든 에이전트 호출이 느려지고
오프라인이 깨진다 — local-first의 핵심 가치다. 공유 채널은 용량이 비-변수라(`040`)
로컬 통째 replicate가 sub-1 MB로 싸므로 레이턴시·오프라인을 거의 공짜로 얻는다. "어떤
기억이 gold인가"는 두 결정으로 갈린다: **코퍼스 쪽 recall**(임베딩 유사도 + ACL,
기계적, 코퍼스가 있어야 함)과 **맥락 쪽 precision/blend**(라이브 task + private 기억이
있어야 함). 후자는 클라이언트에만 있는 정보고, 풍부한 맥락을 서버로 보내면 프라이버시가
새므로, 품질과 프라이버시가 *둘 다* 최종 selection을 로컬로 강제한다. 최종 gold 중재자는
조립된 맥락을 읽는 **소비 에이전트**다.

## 함의 (Implications)

- startup 주입(`context-service.loadStartContext`)은 **두 로컬 소스 — private(권위) +
  replicate된 공유**를 머지하는 자리다. 공유 신선도는 백그라운드 replication sync로 유지하고
  hot-path를 막지 않는다. (순수 클라우드 예외 모드에서만 공유가 원격·best-effort.)
- 서버 쿼리(cloud-MCP) 모델은 **replicate가 부적절할 때만** 쓴다 — (a) 한 워크스페이스에
  코퍼스가 너무 커서 멤버가 다 들기 싫거나, (b) per-query·취소가능 ACL이 필요할 때.
  용량 때문이 아니다(`040`).
- 서버는 ACL + 코스 recall만; 클라이언트가 최종 랭킹·공유↔private 블렌드·budget 분배를
  한다.
- **순수 클라우드(zero-local) 모드 = (C) 하이브리드**: 로컬-authoritative가 기본, 순수
  클라우드는 디스크 없는 환경(웹/ephemeral)용 **명시적 예외 모드**(서버-authoritative +
  개인-쿼리 server-trust 수용). **Hub 하류로 연기**하되, store 접근을 로컬/원격 provider
  뒤로 빼는 **seam을 Hub 작업 때 미리 심는다**(공유-검색에도 재사용). 현실적 형태는 진짜
  zero-local이 아니라 'ephemeral 캐시 + 서버 authoritative'.

## 경계 (Boundaries)

**읽기/주입 hot-path엔 LLM "gold selector"를 넣지 않는다**(기계적 유지) — 소비 에이전트가
최종 중재자이고, LLM 판단은 쓰기/consolidation 시점(salience 점수·태깅)에 둔다. 로컬 통합
메모리가 있는 기본 경로에선 원격 selection 질문 자체가 없다(그 질문은 순수 클라우드
예외에서만 생기며 거기서도 같은 원칙). 순수 클라우드 모드는 (C)로 확정(위 함의·`900`).

## 관련 (Related)

[[040-workspace-sharing-and-capacity]], [[020-identity-and-topology]], [[900-open-decisions]]
