# 저장 경계 유출 금지 목록 (#188 C)

이 문서는 mori의 저장 경계 — 관찰 캡처 → (append-only) 이벤트 로그 → consolidate →
장기 검색 가능한 메모리 — 를 넘어가면 안 되는 값의 정본이다. 새 패턴을 여기서
발명하지 않는다: 아래 두 카테고리는 이미 코드에 있던 정의를 문서로 승격한
것이고, **코드가 정본이며 이 문서는 그 지도**다. 코드와 이 문서가 어긋나면
코드를 따르고 이 문서를 고친다.

## 카테고리 1 — 자격증명 형태 값 (패턴 매칭)

정본: `packages/mori/src/kernel/mask-secrets.ts`의 `SECRET_MASK_PATTERNS` —
개수와 항목은 코드에서 읽어라, 여기 나열하지 않는다.

적용 지점: mori → kernel 경계, 셸 명령 캡처
(`packages/mori/src/kernel/index.ts`의 `createAgentEventObserver`, `shell`
verdict). `observedShell`에 넘기기 **직전** `maskSecrets`를 통과시킨다 — 커널의
이벤트 로그는 append-only라 한 번 적재되면 지울 수 없으므로, 마스킹은 반드시
이 경계를 넘기 전에 일어나야 한다.

**한정(씨앗 목록, 스캐너 아님)**: `SECRET_MASK_PATTERNS`는 완전성을 주장하지
않는 씨앗 목록이다. 예를 들어 `secret-env-assignment`는 `SECRET`/`API_KEY`/
`APIKEY`/`TOKEN`/`PASSWORD`/`PASSWD` 이름만 인식하므로 `CLIENT_CREDENTIAL=abc`
같은 형태는 지금도 마스킹 없이 append-only 로그를 넘어간다. 이 문서는 그런
미커버 형태를 이 카테고리의 "금지"로 주장하지 않는다 — 목표는 흔한 형태를
싸게 잡는 것이지, 새는 경로가 없다고 보장하는 것이 아니다. 미커버 형태를
발견해도 여기서 패턴을 늘리지 않는다(#209 비범위) — 발견은 PR 본문
"발견(범위 밖)"에 남긴다.

해당 이슈: **#129** (셸 명령의 자격증명이 마스킹 없이 평문으로 적재됨).

## 카테고리 2 — 원문 페이로드 에코 금지 (구조적, 패턴 없음)

정의: write-tool 관찰의 자유 텍스트 필드(`summary`/`filePath`)는 **값 자체를
읽어서 consolidate 결과(장기 검색 가능한 메모리)에 옮겨 적으면 안 된다** —
개수·존재 여부·중복 제거 키로만 쓸 수 있다. 카테고리 1과 달리 패턴 목록이
없다: 자격증명이 아닌 임의의 파일 내용(소스 코드, `.env` 앞부분 등)도 똑같이
위험하고 패턴으로는 완전성을 주장할 수 없으므로, 여기서는 "값을 아예 읽지
않는다"는 패턴 매칭보다 강한 보장을 쓴다.

정본: `packages/kernel/src/services/consolidate-service.ts`의
`RuleBasedConsolidator.extract` — write-tool 관찰 묶음을 집계할 때 `filePath`는
`Set`의 멤버십(중복 제거)에만 쓰이고 값 자체는 어떤 출력 텍스트에도 나타나지
않는다.

적용 지점: kernel 내부, LLM이 주입되지 않았을 때의 폴백 추출기(`RuleBasedConsolidator`).

**이 구조적 보장은 `RuleBasedConsolidator`에 한정된다 — `LlmConsolidator`
경로에는 없다.** `MORI_CONSOLIDATE_MODEL`이 설정돼 있거나 커스텀 consolidator가
주입되면 `LlmConsolidator.extract`가 대신 쓰이는데, 그 프롬프트를 만드는
`buildExtractionUserContent`(`consolidate-service.ts`)는 관찰의 `summary`를
가공 없이 그대로 프롬프트에 넣고, 돌아온 `text`는 `parseExtractedMemories`가
페이로드 필터링 없이 그대로 받는다. 즉 `EXTRACTION_SYSTEM_PROMPT`는 모델에게
그러지 말라고 지시할 뿐 구조적으로 막지는 않는다 — 값을 읽어 에코하는 추출을
막는 것은 코드가 아니라 프롬프트 준수 여부다. 이 문서가 "카테고리 2가
구조적으로 막는다"고 말하는 것은 오직 `RuleBasedConsolidator` 경로에서다.

해당 이슈: **#113** (`Edited N file(s): <path 목록>` 형태로 파일 경로/내용이
메모리 본문에 직접 노출됨).

**주의(범위)**: 이 규칙은 append-only 원본 이벤트 로그(`observation.captured`)가
아니라 **consolidate가 만들어내는, 장기 검색 가능한 메모리**에 적용된다. 원본
이벤트 로그 자체에 원문 페이로드가 실리는 것은 이 검사의 대상이 아니다 — 다만
그 원인이 항상 캡처 계약(#109/PR #127) 위반은 아니다: `apply_patch`/`ApplyPatch`
관찰은 그 계약의 **예외**로, `toolInputText`에 원래 raw patch body가 들어오는
것이 정상이다(`capture-service.ts`의 `evaluateCapture` 주석 참고). 패치 헤더에서
경로를 뽑아내면 `filePath`/`summary`에는 경로만 남지만, 헤더를 인식하지 못하면
`evaluateCapture`가 clip된 raw patch body를 그대로 `summary`에 넣는 폴백이 있다
— 계약을 지킨 정상 호출자도 이 경로로 원문을 이벤트 로그에 남길 수 있다는 뜻이다.
그런 경우까지 포함해서, 원본 이벤트 로그에 실제로 무엇이 실렸든 그 값이 검색
가능한 메모리로 **승격**되는 것만큼은(`RuleBasedConsolidator` 경로에 한해)
카테고리 2가 구조적으로 막는다.

## 왜 두 카테고리를 하나의 정의로 합치지 않는가 (모듈 경계)

`mask-secrets.ts`는 `packages/mori`에 있고, 카테고리 2의 적용 지점
(`consolidate-service.ts`)은 `packages/kernel`에 있다. 리포의 모듈 경계 lint
(`eslint.config.js`)는 host → kernel 방향만 허용한다 — kernel이 mori를
import하면 빌드가 깨진다(`NOT_MORI`).

그래서 카테고리 1의 정규식 목록을 kernel 쪽 공용 자리로 옮기지 않았다: 두
카테고리는 애초에 서로 다른 방어 기제다 — 하나는 패턴 매칭(카테고리 1), 하나는
"읽지 않는다"는 구조적 보장(카테고리 2)이고, 카테고리 2에는 애초에 공유할
정규식이 없다. 실제로 공유할 것이 없는데 억지로 하나의 공용 모듈로 합치면
import 경계를 우회하는 코드만 늘어난다. 대신 각 카테고리는 정확히 한 곳에서
정의되고 한 곳에서 적용된다 — "정의가 두 벌로 갈라져 서로 어긋나는" 문제는
같은 정의를 두 곳에 복사할 때만 생기는데, 여기는 그런 복사가 없다.

## 회귀 검사

두 카테고리 모두 이미 각자의 수정 커밋에서 함께 추가된 테스트로 커버된다 —
이 이슈는 새 검사 코드를 추가하지 않고, 그 테스트들이 이 문서가 정의한 경계를
정확히 되돌림에 실패하는 방식으로 지키고 있음을 확인하고 문서와 코드를
상호 참조로 잇는다:

- **카테고리 1 (#129)**: `packages/mori/src/kernel/mask-secrets.test.ts`
  (씨앗 패턴을 `SECRET_MASK_PATTERNS`와 대조해 전부 커버 + "leaves ordinary
  commands with no credential shape untouched"로 오탐 없음을 단언) +
  `index.test.ts`의 "masks credential-shaped values in a captured bash
  command (#129)" (mori → kernel 경계 자체에서 마스킹이 실제로 적용되는지 확인).
- **카테고리 2 (#113)**: `packages/kernel/tests/integration/consolidate-service.test.ts`의
  `describe("consolidate — rule-based fallback never echoes write-tool content (#113)")`
  아래 테스트들 — 자격증명 형태 값을 `filePath`/`summary`에 주입해도 저장된 메모리
  텍스트에 나타나지 않음을 확인하는 테스트, 그리고 경로 값 없이 개수만으로
  dedup됨을 확인하는 테스트.

원래 수정 커밋(#113: `f9e2419`, #129: `b1deea6`)을 되돌려 위 테스트들이
실제로 실패하는지, 그리고 오탐 방지 단언이 여전히 통과하는지는 PR 본문에
실행 결과로 남긴다.
