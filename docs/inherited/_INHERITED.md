# 이 폴더는 규격이 아니다

여기 있는 문서는 **전신 프로젝트 `memorize`의 기록**이다. 무엇을 왜 그렇게 정했는지를
남긴 것이지, mori가 지켜야 할 요구사항이 아니다.

## 왜 이 경고가 필요한가

mori는 memorize의 의미론을 **의도적으로 재협상 대상으로 둔다.** [#115](https://github.com/shakystar/mori/issues/115)의
설계 입력이 그렇게 규정했다:

- `packages/kernel/src/domain/entities/sync-state.ts`는 **"규격이 아니라 잔재"** — 업스트림
  hub의 현재 어휘를 타입만 이식한 상태이고 구동 엔진이 없다. 새 동기화 아키텍처는 이
  타입에 맞추지 말고 **백지에서 재정의**할 것.
- `packages/kernel/src/projections/projector.ts`의 whole-DB union 의미론은 hub가 공진화
  대상이 되었으므로 **재협상 가능**으로 취급할 것.

이 문서들을 규격으로 읽으면 벗어나려던 가정을 그대로 수입하게 된다. 그게 이 폴더를
`inherited/`로 격리한 이유다.

## 읽는 법

- **맥락으로 읽어라.** "왜 이런 문제가 있었나", "어떤 선택지를 이미 시험했나".
- **요구사항으로 읽지 마라.** "SoT에 그렇게 적혀 있다"는 구현 근거가 되지 않는다.
  mori가 지킬 것은 mori 자신의 문서·이슈에 다시 적혀야 효력이 있다.
- 특히 `030-sync-and-merge.md`·`031-canonical-remote-transport.md`·
  `060-storage-locality-and-retrieval.md`는 #115가 다시 정하는 영역이다. 참고만 하라.

## 서버 쪽

서버(hub)의 대응 기록은 [`mori-nest`](https://github.com/shakystar/mori-nest)의
`docs/inherited/memorize_hub-SoT/`에 있고, 새 프로토콜 요구사항은 같은 리포
`docs/design/0001-protocol-requirements.md`에 있다.

## 출처

| 폴더 | 원본 |
|---|---|
| `memorize-SoT/` | `shakystar/memorize` `docs/SoT/` (18파일) |
