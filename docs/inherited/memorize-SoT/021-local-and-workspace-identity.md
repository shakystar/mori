# SoT-021: 로컬 정체성(proj_)과 통합 워크스페이스 정체성(wsp_)

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): SoT-020 (정체성 발급 권위 + proj_/wsp_ 관계 부분만; folderIdentity·멀티계정 조항은 020에서 유효)
대체됨(Superseded-by): SoT-022 (통합층 genesis를 `workspace.created` 이벤트로 표현한 메커니즘 서술 부분만; 2축 정체성·layering·provenance 조항은 여기서 유효)

## 진술 (Statement)

memorize의 store 정체성은 **두 개의 동등한 축**이다: `proj_`(로컬 프로젝트 정체성)와
`wsp_`(통합 워크스페이스 정체성). **어느 쪽도 다른 쪽에 대해 authoritative하지 않으며**,
사용자가 무엇을 하느냐에 따라 중심이 바뀐다 — 로컬 프로젝트 폴더를 열면 `proj_`, sync된
통합 워크스페이스를 다룰 땐 `wsp_`. `project.created`(로컬 `proj_` genesis)는 **Hub
없이·오프라인에서도 항상 존재**하는 로컬 정체성이다. `workspace.created`(통합층 genesis,
server-minted `wsp_`)는 **sync가 시작될 때 `proj_` 위에 얹히는** 원격 정체성으로, `proj_`를
rekey하거나 대체하지 않는다. 서버가 발급하는 store id는 **원격 라우팅·coordination 권위**
이지 로컬 정체성의 권위가 아니다. 두 정체성은 같은 물리 store 안에 공존하며, 로컬 뷰와
통합 뷰는 provenance로 갈린다(저장은 [[040-workspace-sharing-and-capacity]]).

## 근거 (Why)

- **순수 로컬 사용자**(Hub 미사용·오프라인)는 `wsp_`가 아예 없다. genesis를 워크스페이스
  층(`workspace.created`)으로 통일하면 이들이 정체성을 가질 수 없다 — 그래서 로컬 genesis는
  `project.created`(`proj_`)여야 하고 항상 존재해야 한다(local-first, [[010-surfaces-and-boundaries]],
  [[060-storage-locality-and-retrieval]]).
- **그러나 로컬이 권위인 것도 아니다.** 통합 워크스페이스를 다룰 땐 `wsp_`가 정체성이고 각
  `proj_`는 provenance 라벨(`sourceProjectId`)로 남는다. 두 모드가 대등한 1급 사용 방식이다.
- **콘텐츠/클라 파생 정체성 안티패턴은 유효**하다(020 유지): 원격 coordination id는 서버가
  발급한다. 021이 정정하는 것은 그 서버 발급이 *로컬 정체성까지* 권위로 삼도록 읽혔던 부분
  뿐이다 — 서버 발급은 원격 경로에 한정된다.

## 함의 (Implications)

- `project.created`는 **로컬 store당 하나**(로컬 정체성). capture/session-start 경로는 이
  genesis가 항상 존재하도록 보장해야 하며, genesis 없이 관찰/기억만 쌓아선 안 된다.
- `reduceProjectState`는 **self `proj_`의 `project.created`만** 정체성으로 취급하고, union
  으로 들어온 다른 `proj_`의 genesis는 정체성이 아니라 **provenance 라벨**로 둔다. 워크스페이스
  union이 같은 DB로 들어와도 "divergent identity"로 throw하지 않는다.
- 원격 sync/라우팅은 **server-minted store id**(`wsp_`, `psm_`)로 한다. `proj_`는 로컬
  정체성 + `sourceProjectId` provenance이지 원격 라우팅 키가 아니다.
- `wsp_`는 통합의 정체성으로 **로컬 `proj_`와 같은 물리 `memorize.db`**에 담긴다(별도 물리
  store가 아니다) — 저장·replicate 규칙은 [[040-workspace-sharing-and-capacity]].

## 경계 (Boundaries)

- SoT-020의 **folderIdentity(discovery 힌트)와 멀티계정 격리** 조항은 유효하다 — 021이
  정정하는 범위는 "정체성 발급 권위"와 `proj_`/`wsp_` 관계뿐이다.
- 개인 store(`psm_`)의 물리 분리는 [[010-surfaces-and-boundaries]] 소관이다.
- 워크스페이스 통합의 **물리 저장/replicate**(같은 DB union, provenance 미융합, 중복 보유)는
  [[040-workspace-sharing-and-capacity]] 소관이다.
- `wsp_` 발급 **시점**(오프라인-first 생성 시 로컬 `proj_`로 시작하고 첫 sync에서 `wsp_`를
  매핑) 등 전환 메커니즘은 구현 계획 소관이다 — 여기선 "`wsp_`는 `proj_`를 대체하지 않고
  매핑으로 얹힌다"만 단언한다. (Hub 쪽 `H050`의 "서버-mint 유일권위 / `proj_`는 provenance
  로만" 표현은 이 결정과 정합되게 별도 조정 대상.)

## 관련 (Related)

[[020-identity-and-topology]], [[040-workspace-sharing-and-capacity]], [[010-surfaces-and-boundaries]], [[030-sync-and-merge]], [[900-open-decisions]]
