# SoT-070: 보안 입장 (at-rest, E2E 아님)

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

v1의 보안은 **서버사이드 at-rest 암호화 + 접근제어**다. **end-to-end가 아니다** —
GitHub가 private repo를 평문으로 읽을 수 있는 것과 같이, 서버가 공유 데이터를 읽을 수
있다. OAuth는 계정을 **인증**할 뿐 복호화 키가 **아니다**. E2E(store별 데이터 키, 디바이스
등록, 멤버별 키 래핑)는 **연기**한다 — v1 필수가 아니라 advanced opt-in이다. URL은
locator/invite지 영속 비밀이 아니다(`020`).

## 근거 (Why)

E2E를 v1에 넣으면 두 가지가 깨진다. 첫째, "discover-before-mint"로 새 기기가 서버에서
private store를 clone하려면 서버가 평문을 줄 수 있어야 하는데, E2E면 키 관리 없이는
복호화 불가라 의존성이 꼬인다. 둘째, 기기 하나만 있고 잃으면 영구 소실되는데, 이는 "절대
맥락을 잃지 않는다"는 제품 가치와 정면 모순이다. GitHub 모델(at-rest + 접근제어)은 이 둘을
모두 해소한다 — 노트북을 잃어도 다시 clone하면 된다. 또한 공유 기억의
consolidation(`040`/`900`)을 서버가 1회 돌려 모두가 혜택을 보려면 서버가 평문을 봐야 한다.

## 함의 (Implications)

- 프라이버시는 *접근제어*로 강제하지 E2E로 강제하지 않는다(v1). 개인 store의 격리는
  암호화가 아니라 "절대 떠나지 않음"으로 보장한다(`010`).
- 서버는 신뢰 경계다 — 공유 데이터·consolidation·recall이 거기서 돈다는 전제로 설계하라.
- 기존 수동 `--encryption-key` 경로는 저수준 primitive로 남기되, 크로스-디바이스 clone의
  완성된 제품 UX로 취급하지 마라.

## 경계 (Boundaries)

E2E로 언제 넘어갈지, 그리고 E2E의 복구(recovery) 대 zero-knowledge 긴장을 어떻게 풀지는
**미결**(`900`)이다. 이 문서는 v1 기준선만 정한다.

## 관련 (Related)

[[020-identity-and-topology]], [[010-surfaces-and-boundaries]], [[900-open-decisions]]
