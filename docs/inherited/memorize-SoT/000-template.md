# SoT-NNN: <제목>

상태(Status): Invariant | Decision | Open
확정(Since): YYYY-MM-DD
대체함(Supersedes): SoT-NNN | —
대체됨(Superseded-by): SoT-NNN | —

## 진술 (Statement)

한 문단으로, 얼버무리지 말고 규칙으로 단언한다. 이 시스템에서 무엇이 참인가.

## 근거 (Why)

이 규칙을 강제하는 이유. **Invariant**라면, 아키텍처(append-only 로그, union
sync, local-first)의 무엇이 이걸 *불가피*하게 만드는지를 적는다 — 단지 "좋아서"가
아니라. **Decision**이라면, 받아들인 트레이드오프와 기각한 대안을 적는다.

## 함의 (Implications)

이게 하류에서 무엇을 제약하는가. 이것 때문에 구현자가 *하면 안 되는* 것은 무엇인가.

## 경계 (Boundaries)

이 문서가 *주장하지 않는* 것. 예외 사례. 어디서부터는 다른 SoT 문서가 맡는가.

## 관련 (Related)

[[010-surfaces-and-boundaries]], [[050-deletion-and-revert]], …
