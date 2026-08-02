# SoT-042: 위임 전달은 송신 즉시 push + 세션-묶인 워처(pull)다

상태(Status): Decision
확정(Since): 2026-07-03
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

프로젝트 간 위임([[041-cross-project-delegation]])의 전달 지연은 두 절반으로 나뉘며 각각
따로 해결한다. **송신 절반**: `task request`류 커맨드는 이벤트 append 직후 **인라인
autoPush를 한 번 수행**해 요청이 세션 종료를 기다리지 않고 즉시 Hub에 도착하게 한다.
**수신 절반**: 머신에 상주하는 OS 서비스가 아니라, **세션에 수명이 묶인 워처 프로세스**가
맡는다 — SessionStart 훅이 lockfile+PID 생존 체크로 워처 부재 시 detached 스폰하고,
워처는 짧은 간격(기본 ~30초)의 watermark pull을 돌리다가 인바운드 요청을 발견하면 **로컬
마커 파일**을 쓰고, 마지막 `session.heartbeat`가 일정 시간 이상 오래되면 스스로 종료한다.
에이전트의 per-turn 인지는 **네트워크 없는 로컬 파일 stat만**으로 한다. per-turn 훅에
네트워크 폴링을 거는 것은 금지다("per-turn 비싼 작업 금지, PostToolUse 금지" 규칙 유지).

## 근거 (Why)

- **폴링 부하는 문제가 아니다**: pull은 watermark-gated라 받을 게 없으면 HTTP 왕복
  한 번이다([[030-sync-and-merge]]). 30초 간격이어도 클라이언트·Hub 양쪽에 무시할
  수준이므로, 별도 알림 엔드포인트 없이 기존 pull이 곧 저렴한 체크다.
- **진짜 제약은 상주성이었다**: memorize 클라이언트는 경계 훅에서만 도는 CLI라
  세션 경계 sync만으로는 (a) 요청이 요청자의 세션 종료까지 안 올라가고 (b) 대상은
  다음 세션 시작까지 못 본다. 송신 인라인 push가 (a)를, 워처가 (b)를 푼다.
- **세션-묶인 수명이 데몬의 무서운 부분을 전부 제거한다**: 실시간 알림의 소비자는
  살아있는 에이전트 세션뿐이다 — 세션이 없으면 실시간일 이유가 없고 다음 SessionStart
  pull이 어차피 받아온다. 따라서 부팅 자동시작·OS 서비스 등록·트레이 앱·영구 상주가
  전부 불필요하고, 크래시 복구는 "다음 세션 시작이 재스폰"으로 끝난다(Gradle 데몬 모델).
- **기각한 대안**: (1) per-turn 훅 네트워크 폴링 — rc.0-4에서 확정한 per-turn 규칙
  재론이라 기각. (2) OS 서비스/설치형 상주 데몬 — 세션 없는 시간의 실시간성은 무가치
  한데 수명 관리 비용은 최대라 기각. (3) Hub SSE/long-poll push — v1 필수 아님, 폴링
  간격이 부족해질 때의 후속 최적화로 연기.
- **detached 스폰과 heartbeat는 이미 있는 패턴이다**: consolidate가 훅 경계 detached
  child(windowsHide, unref, stuck-child reaping)로 돌고 있고 `session.heartbeat`
  이벤트도 존재한다 — 신규는 long-lived 루프의 수명 관리뿐이다.

## 함의 (Implications)

- 종단 지연의 설계 목표: 송신 0초(인라인 push) + 워처 폴 주기(≤30초) + 다음 툴 경계.
  이 이상의 실시간성(SSE 등)은 이 문서를 대체하는 문서로만 도입한다.
- 워처는 **단일 인스턴스 보장**이 필요하다: lockfile 원자적 획득 + stale lock 판정
  (PID 생존 체크). 두 세션 동시 시작 레이스에서 워처가 둘 뜨면 안 된다.
- 워처의 폴링 단위는 **v1은 프로젝트당 하나**(consolidate와 같은 프로젝트 바인딩 모델).
  머신당 하나로의 통합은 프로젝트 수가 실측으로 문제 될 때의 후속이다.
- 인라인 push·워처 pull 실패는 **경고로 강등하고 no-op** — auto-sync의 기존 규율
  그대로, 위임 기능이 세션을 깨뜨리면 안 된다.
- 프로세스 수명 코드는 Windows 특이점(프로세스 kill, 콘솔 창)에 데인 전례가 있으므로
  **3-OS CI를 게이트로** 한다. 로컬 green은 증거가 아니다.
- 마커 파일→컨텍스트 주입의 구체 표면(어느 훅, 어떤 문구)은 구현 소관이되, per-turn
  네트워크 금지는 여기서 확정이다.

## 경계 (Boundaries)

- 위임의 의미론(제안-수락, 주소 지정, 에스컬레이션)은 [[041-cross-project-delegation]]
  소관 — 이 문서는 전달(transport 위 배달 시점)만 정한다.
- 워처는 위임 알림을 위해 도입하지만, 발견하는 것은 watermark pull의 전체 인바운드다 —
  위임 외 이벤트의 mid-session 표면화를 어디까지 할지는 여기서 정하지 않는다(후속 결정).
- transport 자체(canonical Hub 경로)는 [[031-canonical-remote-transport]] 소관.

## 관련 (Related)

[[041-cross-project-delegation]], [[030-sync-and-merge]], [[031-canonical-remote-transport]], [[040-workspace-sharing-and-capacity]]
