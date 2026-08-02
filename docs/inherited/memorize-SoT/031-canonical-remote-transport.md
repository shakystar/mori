# SoT-031: canonical 원격 sync 경로는 Hub(server-minted id)다 — file transport는 deprecated

상태(Status): Decision
확정(Since): 2026-07-03
대체함(Supersedes): — (030의 union 의미론은 그대로; 이 문서는 *transport 계층*의 canonical 경로만 정한다)
대체됨(Superseded-by): —

## 진술 (Statement)

원격 sync의 **canonical 경로는 Hub(gateway)이며, 라우팅 키는 server-minted store
id(`wsp_`/`psm_`)다.** raw `proj_`를 원격 경로 id로 쓰는 바인딩(pre-workspace 시절의
first-push self-bind)은 레거시이며, **sync 경계에서 자동으로 canonical `wsp_` 바인딩으로
수렴(reconcile)된다** — gateway는 raw client id를 403으로 거부해 왔으므로 옮겨올 원격
히스토리가 없고, reconcile은 "1-멤버 `wsp_` mint → 리바인드 → watermark 리셋 → 전체
재푸시"로 무손실이다. **file transport(공유 폴더)는 3.0.0부터 deprecated**다: 동작은
유지하되 동결(frozen)하고, 문서에서 내리고, CLI 사용 시 경고를 출력하며, 이후 릴리스에서
제거한다. **bare relay**(gateway 없는 events-route-only 서버)는 별도 코드가 아니라 http
transport의 한 사용법이므로 코드는 남지만, **지원을 문서화하지 않는다**(동작하는
escape-hatch일 뿐 계약이 아니다).

## 근거 (Why)

- file transport(P3-b)와 relay(P3-b-2)는 **Hub 이전 시대의 sync 전부**였다 — 당시엔
  합리적 설계였으나, 3.0.0 로드맵(W2)이 크로스-디바이스의 canonical 경로를 Hub 기반
  `wsp_`로 정하면서 역할이 끝났다.
- local-first 불변([[021-local-and-workspace-identity]])이 보장하는 것은 "Hub 없이도
  로컬 정체성과 기억이 존재한다"이지 "서버 없는 멀티기기 sync를 제공한다"가 아니다 —
  file transport 제거는 불변을 깨지 않는다.
- 두 갈래 바인딩 의미론(raw `proj_`가 유효한 세계 vs server-minted id의 세계)을 유지하는
  비용이 그 효용을 넘어섰다: self-bind 레거시 경로, 이중 doctor 규칙, reconcile 분기가
  전부 여기서 나온다.
- 즉시 삭제가 아니라 deprecate인 이유: 2.5.0은 npm 배포본이라 `--remote-path` 사용자가
  존재할 수 있고, 동결된 채 두면 레거시로 자연 격리되므로 제거를 서두를 필요가 없다.

## 함의 (Implications)

- sync 경계(수동 `project sync --push/--pull`, autoPush/autoPull)는 http transport에서
  레거시 형태를 만나면 best-effort로 reconcile한다(`reconcileWorkspaceBinding`):
  `proj_`/무바인딩 → `wsp_` mint + watermark 리셋, role 캐시 없는 `wsp_` → 캐시 백필.
  실패는 경고로 강등하고 레거시 경로로 계속 진행한다(bare relay의 404가 그 예).
- doctor는 레거시 바인딩과 file transport를 warn으로 표면화한다(`sync.binding`).
- `--remote-path`는 사용 시 deprecation 경고를 출력하고, AGENT_GUIDE 등 공개 문서에서
  내린다. auto-sync의 file 경로는 경고 없이 동작 유지(기존 사용자 스팸 방지).
- 새 기능은 file transport를 고려 대상에서 제외한다(동결의 의미).

## 경계 (Boundaries)

- union/merge 의미론(append-only, G-Set)은 [[030-sync-and-merge]] 소관 — 이 문서는
  어느 transport가 canonical인지만 정한다.
- `wsp_` 정체성이 control-plane이라는 사실은 [[022-workspace-identity-is-control-plane]],
  `proj_`/`wsp_` 2축 정체성은 [[021-local-and-workspace-identity]] 소관.
- file transport의 실제 **제거 시점**은 미정(이후 릴리스) — 제거 시 이 문서를 대체하는
  문서로 확정한다.

## 관련 (Related)

[[021-local-and-workspace-identity]], [[022-workspace-identity-is-control-plane]], [[030-sync-and-merge]], [[040-workspace-sharing-and-capacity]]
