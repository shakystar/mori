# SoT-010: 표면(surface)과 단 하나의 하드 경계

상태(Status): Invariant
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

memorize의 기억은 **두 축**으로 정의된다 — **scope 축**(개인 = 프로젝트를 가로지름 vs
프로젝트 = 한 폴더)과 **access 축**(단일 계정 = private vs 다중 계정 = shared). 여기서 세
표면이 나온다: **개인**(개인 scope · 단일 계정), **private 프로젝트**(프로젝트 scope ·
단일 계정), **공유 프로젝트**(프로젝트 scope · 다중 계정).

하드 경계는 **access 축**에 있다: **단일 계정 기억은 절대 다른 계정으로 건너가지
않는다**(workspace·share·publish·cross-account clone 금지). 단, 단일 계정 기억은 **같은
계정의 자기 기기 간으로는 sync된다** — 개인 계정 로그인 + 사용자가 명시적으로 동기화한
경우에 한해. **sync 여부는 access 축과 직교**다: private도 sync하고 shared도 sync한다;
다른 것은 *누구에게* 가느냐다.

## 근거 (Why)

개인 선호가 공유 기억으로 새는 #181은 "다른 계정으로 건너감"의 한 사례다. 이를 구조적으로
막는 규칙은 "절대 sync 안 함"이 아니라 **"다른 계정으로 안 감"**이다. 개인 store는 별도
store(`~/.memorize/personal/`, `PERSONAL_STORE_ID = 'personal_self'`)라 프로젝트/워크스페이스
흐름에 물리적으로 섞이지 않으며, 이 물리 분리가 cross-account 금지를 구조적으로 강제한다.
개인 scope에는 **다중 계정 버전이 없다**(공유 개인 기억이란 건 없다) — 그래서 개인은 본질적
으로 단일 계정이고, 계정당 고유본 하나가 자기 기기 간에만 sync된다. private 프로젝트도 같은
access 불변을 공유한다(자기 기기로 sync, 다른 계정엔 안 감); 개인과의 유일한 차이는
scope뿐이다.

## 함의 (Implications)

- `assertNotPersonalStore`는 현재 개인 store의 **모든** sync를 막는데, 이는 과차단이다.
  cross-account/workspace 경로만 막고 **계정-scope 개인 sync 경로**(같은 계정 기기 간)는
  허용하도록 정밀화해야 한다(계획 M2).
- 개인 sync는 **명시적**이다: 개인 계정 로그인 + 사용자가 동기화 누름, 자동 백그라운드
  아님. (이 manual-gating은 그 위에 얹힌 *Decision*이라 바뀔 수 있다; cross-account 금지가
  *Invariant*다.)
- 와이어에서 빠지는 것은 "개인 store 전부"가 아니라 "개인 store의 *cross-account/워크스페이스*
  방향"이다(`040` 정밀화).
- "이 프로젝트 기억을 나만"은 워크스페이스 미합류로, "개인 기억"은 scope로 달성하지 이벤트별
  프라이버시 플래그로 하지 않는다.

## 경계 (Boundaries)

- **혼자 있는 워크스페이스**는 single-writer로 degenerate된 *공유* store다: union에 네
  이벤트만 있어 내용상 private과 구별 불가지만, 남이 invite로 join *할 수 있다는*
  도달가능성에서 순수 private store와 다르다. 두 번째 멤버 합류는 네 데이터의 상태 전이가
  아니라 *누가 도달하느냐*의 변화일 뿐이다(`040`).
- 계정 전환은 계정별 폴더 격리로 충돌 없이 공존하며 비파괴적이다(`020`); 이전 계정
  개인기억이 디스크에 남는 것은 수용된 트레이드오프다. 이전 계정 데이터를 *의도적으로*
  지우는 명시 **`account purge/detach`를 옵션으로 제공**한다(기본은 보존, 확인 프롬프트
  있는 opt-in).
- 기억 텍스트에 실수로 박힌 비밀은 content-sanitization 별도 트랙(아키텍처 경계 아님).

## 관련 (Related)

[[040-workspace-sharing-and-capacity]], [[020-identity-and-topology]], [[070-security-stance]], [[900-open-decisions]]
