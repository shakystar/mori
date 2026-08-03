# SoT-022: 워크스페이스 정체성은 control-plane이다 (`workspace.created` 이벤트 아님)

상태(Status): Decision
확정(Since): 2026-07-02
대체함(Supersedes): SoT-021 (통합층 genesis를 `workspace.created` **이벤트**로 표현한 메커니즘 서술 부분만; 2축 정체성·layering·provenance 조항은 021에서 유효), SoT-050 (계획의 `workspace.memory.retracted` 참조 부분만)
대체됨(Superseded-by): —

## 진술 (Statement)

`wsp_` 정체성·`role`·`invite_reachable`·membership은 **Hub gateway의 control-plane 사실**
이며 typed endpoint로 fetch한다 — **도메인 이벤트(`workspace.created` 등)로 표현하지
않는다.** relay는 opaque하고 이벤트를 저작·파싱하지 않으며(H010), control-plane DB는
이벤트 데이터를 담지 않는다(H010). 공유 `wsp_` 로그는 멤버들의 **whole project DB union**
이고, 그 genesis는 각 멤버 **자신의 `project.created`**(자기 `proj_`를 `sourceProjectId`
provenance로 실은 것)들이다 — **별도 workspace genesis 이벤트는 없다**. `wsp_`는 remote
라우팅 id로서 클라이언트 sync-state(`remoteProjectId`)에 바인딩되며, 로컬 `proj_` 정체성을
rekey하지 않는다([[021-local-and-workspace-identity]] 유지).

## 근거 (Why)

- **H010(Invariant) 2-plane 경계**가 강제한다: relay는 dumb·opaque(`event.id`로만 라우팅),
  gateway는 payload를 파싱/저작하지 않는다. 정체성·멤버십·역할은 "누가 무엇에 접근하는가"의
  *판단*이 필요한 제어이고, 그것을 opaque 데이터평면(이벤트 로그)에 넣는 순간 relay가 더는
  opaque하지 않다. [[H040]]은 이를 `stores`/`memberships` 행으로 못박았다.
- **서버 authoring은 불가**: control-plane DB는 이벤트를 담지 않으므로 gateway가
  `workspace.created`를 shared 로그에 시딩할 수 없다(H010).
- **client-authored `workspace.created`조차 자기 자리를 못 얻는다**: (1) 클라는 "workspace
  store"를 reduce하지 않는다 — 각 멤버는 **자기 `proj_` store**(union을 담은)를 reduce하고
  그때 self는 자기 `proj_`다. 앵커할 감축이 없다. (2) self-lane 규율상 그 이벤트는 owner에겐
  self-lane, **모든 joiner에겐 foreign-lane이라 무시**된다 — 정작 워크스페이스 존재를 배워야
  할 joiner에겐 무용하고 owner에겐 잉여다. (3) `role`/`invite_reachable`/`name`/membership을
  데이터평면에 복제하면 rename(`PATCH`)·역할변경·invite flip 시 즉시 stale 미러가 된다.
  생성 audit("누가·언제")조차 control-plane `stores.created_by/created_at`로 이미 커버된다.

## 함의 (Implications)

- 클라는 `wsp_`/`role`/roster를 gateway endpoint로 얻는다: `POST /v1/workspaces`,
  `GET /v1/account/workspaces`, `GET /v1/workspaces/:id`(store-resolution.md, workspace.md).
  로컬엔 sync-state의 `remoteProjectId`(=`wsp_`) + `role`/`invite_reachable` **캐시**(권위
  아님; sync 시 gateway에서 refresh)만 둔다.
- **새 `workspace.*` 도메인 이벤트 타입을 추가하지 마라.** `DomainEventType`·`scopeType`에
  `workspace`를 넣지 않는다. 워크스페이스는 `scopeType` 값이 아니다.
- `reduceProjectState`는 **authoritative self `proj_`**를 인자로 받아, union으로 들어온 다른
  `proj_`의 `project.created`를 정체성이 아니라 provenance로 두고 divergent-throw 대상에서
  제외한다(021 함의와 동일 — 이번엔 이벤트 없이 달성).
- **owner 전역 retract**는 별도 `workspace.memory.retracted`가 아니라 **일반
  `memory.retracted`를 projection이 이벤트의 writer role로 판정**한다([[050-deletion-and-revert]],
  [[H030]]). 050의 "(계획의) `workspace.memory.retracted`" 표현은 실제 착지한
  `memory.retracted`(비-workspace-prefixed, M3)로 대체된다.

## 경계 (Boundaries)

- **021의 핵심 Decision은 그대로 유효**하다: `proj_`/`wsp_` 2축 동등, `wsp_`가 `proj_` 위에
  layering(rekey 금지), foreign `proj_`=provenance 라벨. 022는 그 통합층의 **표현
  메커니즘**(이벤트 vs control-plane)만 정정한다.
- `wsp_` 발급 시점/전환(오프라인 `proj_`로 시작 → 첫 sync에서 `wsp_` 매핑)은 구현 계획 소관
  (store-resolution.md).
- whole-DB union push/pull 실제 배선, 역할 강제, workspace CLI는 W-b/W-c/W-d 소관이다.

## 관련 (Related)

[[021-local-and-workspace-identity]], [[040-workspace-sharing-and-capacity]], [[050-deletion-and-revert]], [[010-surfaces-and-boundaries]], [[030-sync-and-merge]]. Hub: H010(2-plane), H040(control-plane data model), H050(identifier namespaces).
