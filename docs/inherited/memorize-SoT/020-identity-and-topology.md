# SoT-020: 정체성과 git/GitHub 토폴로지

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): SoT-021 (정체성 발급 권위 + proj_/wsp_ 관계 부분만; folderIdentity·멀티계정 조항은 여기서 유효)

## 진술 (Statement)

memorize는 로컬을 **지원하는** SaaS이며, git/GitHub를 모델로 삼는다: **로컬 store는
완전한 replica**(오프라인 작동, 내 작업에 대해 authoritative)이고, **서버가 정체성·
접근제어·discovery·coordination을 쥔다**. store 정체성은 **서버가 발급**한다(루트는
OAuth의 `accountId`; `personalStoreId`·`privateProjectStoreId`·`workspaceId`는 서버가
mint). `folderIdentity`(git origin / root commit / repo 경로)는 기껏해야 **discovery
힌트**일 뿐, 영속 정체성이 절대 아니다. sync URL은 **locator / invite**지 비밀이 아니다.

**git 연결을 가정하지 않는다.** folderIdentity 힌트는 git이 있을 때만의 옵션 편의(개발자
ergonomics)이고, 정체성·링킹의 기본 경로는 **명시적 바인딩**(폴더↔store)과 **워크스페이스
join(invite)**이다 — git 불필요. 워크스페이스는 마케터·디자이너·개발자의 *이질적
폴더/store*를 가로질러 묶으며, 멤버가 git을 공유하거나 쓸 필요가 없다.

## 근거 (Why)

이전 계획이 콘텐츠 파생 `folderIdentity`에 손댄 건 오직 *dumb relay*가 id를 발급하지
못하기 때문이었다 — coordinator가 없으면 두 머신은 공유 콘텐츠에서 id를 *유도*해야만
합의할 수 있다. 똑똑한 서버를 허용하는 순간(=SaaS 선택), 서버가 id를 발급하고(GitHub가
root commit이 아니라 `owner/repo` + 숫자 id를 mint하듯), 콘텐츠 파생 정체성은
안티패턴이 된다: root commit은 충돌하고(템플릿), fork는 모호하고, origin 변경은 깨지고,
non-git 폴더는 경로로 회귀한다. `git clone <url>`이 모델이다 — URL이 위치를 가리키고,
서버가 정체성을 정한다.

## 함의 (Implications)

- 협업이나 크로스-디바이스 연속성을 콘텐츠 해시에 묶지 마라. 서버로 discover하고(`gh
  repo list` 유추), URL/id로 attach하라.
- `folderIdentity`는 "이 폴더 origin과 매칭되는 store가 있는데 attach할래?" 수준의
  편의로만 제시하고, 계정-private로 둬도 된다(사람을 잇기 위해 계정 간 비교에 절대 쓰지
  않는다 — 그건 *워크스페이스 join*이 할 일). 힌트 계산 = git origin + root commit +
  **repo-상대경로**(monorepo 패키지별 분리), non-git 폴더는 **절대경로 fallback**(저신뢰).
  틀려도 수동 attach로 복구된다.
- OAuth가 계정을 확립하고, 토큰은 호스트 credential store에 둔다(#192 선례). URL은
  영속 비밀을 절대 운반하지 않는다.
- **여러 계정이 한 로컬에 로그인할 수 있다.** 계정-scope store(개인 + private 프로젝트)는
  **계정별 폴더로 격리**한다(예: `~/.memorize/accounts/<accountId>/…`) — 그래서 계정
  전환에 충돌/clobber가 없고 비파괴적이다(이전 계정 데이터는 남아 switch-back 시 복원).
  주입 시 어느 개인 store를 읽을지는 **활성 계정**이 정한다(폴더 바인딩과 별개 축).
  잔여: 이전 계정 개인기억이 공유 디스크에 남는다 — 수용된 트레이드오프이며, *다른
  사람*과 머신을 공유할 때의 at-rest 노출만 별도 트랙(`070`)이다.

## 경계 (Boundaries)

아직 미구현이다 — 오늘은 `accountId`/login이 없다(개인 store는 하드코딩 싱글톤).
이 문서는 *방향*을 못박는다. 계정 교체 시 명시적 purge/detach는 옵션으로 제공한다(기본
보존, `010`); monorepo는 힌트에 repo-상대경로 포함으로 해소(힌트라 저위험). OAuth는
인증하지 복호화하지 않는다(`070`).

## 관련 (Related)

[[070-security-stance]], [[060-storage-locality-and-retrieval]], [[900-open-decisions]]
