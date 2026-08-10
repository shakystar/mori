# ImplicitMemBench (arXiv 2604.08064) 300문항 공개 배포처 확인

## 판정

**입수 가능** — 원 논문(arXiv 2604.08064)이 각주에서 직접 링크하는 저자 공식 GitHub
리포 <https://github.com/qinchonghanzuibang/ImplicitMemBench> 에 300문항 데이터셋이
`dataset/{procedural_memory,classical_conditioning,priming}/`로 실제 커밋돼 있고,
HuggingFace 컬렉션 <https://huggingface.co/collections/J017athan/implicitmembench>에도
같은 데이터셋이 "300 items"로 명시되어 뷰어로 공개 배포돼 있다. 라이선스는 데이터
CC BY 4.0, 코드 MIT.

## 출처별 확인 기록

| 출처                          | URL                                                           | 확인 시각 (UTC)   | 있었던 것 / 없었던 것                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| arXiv abs                     | https://arxiv.org/abs/2604.08064                              | 2026-08-10T09:01Z | 논문 존재 확인(제목·저자 일치). abs 페이지 자체에는 code/data 링크 미노출(토글만 있고 채워지지 않음).                                                                                                                                                                                                                                                                 |
| arXiv HTML 전문               | https://arxiv.org/html/2604.08064                             | 2026-08-10T09:01Z | 각주에 "Code and data are available at [ImplicitMemBench](https://github.com/qinchonghanzuibang/ImplicitMemBench)" 명시. 교신저자: Xiachong Feng (HKU, fengxc@hku.hk). 공동저자: Chonghan Qin(HKU), Weitao Ma(HIT), Xiaocheng Feng(HIT), Lingpeng Kong(HKU).                                                                                                          |
| GitHub 검색 → 저자 리포       | https://github.com/qinchonghanzuibang/ImplicitMemBench        | 2026-08-10T09:01Z | README에 "released benchmark data in `dataset/`" 명시. `dataset/procedural_memory`(15개 json, 각 파일에 `task_count`+`instances` 배열), `dataset/classical_conditioning`(10개), `dataset/priming`(10개) 확인. 코드 LICENSE=MIT, `dataset/LICENSE`=CC BY 4.0 (원문 확인: "This dataset is licensed under the Creative Commons Attribution 4.0 International License"). |
| HuggingFace datasets/컬렉션   | https://huggingface.co/collections/J017athan/implicitmembench | 2026-08-10T09:01Z | `J017athan/ImplicitMemBench` 데이터셋이 뷰어로 공개, **"300 items"** 명시(업데이트 5/23). 같은 컬렉션에 논문 카드(ACL 2026 Best Resource Paper 표기)도 포함.                                                                                                                                                                                                          |
| Papers with Code / OpenReview | https://paperswithcode.com/search?q=ImplicitMemBench          | 2026-08-10T09:01Z | 전용 PwC 페이지 검색 결과 없음(다른 벤치들만 검색됨). OpenReview는 별도 확인하지 않음 — GitHub·HuggingFace 양쪽에서 이미 공개 배포가 실물로 확인되어 추가 조회가 판정에 영향을 주지 않음.                                                                                                                                                                             |

## 참고: 논문 서술과의 일치

논문 abstract/본문이 서술하는 300문항, 3개 구성(Procedural Memory / Priming /
Classical Conditioning), Learning-Interfere-Test 프로토콜과 GitHub `dataset/` 구조
(3개 task family 디렉터리) 및 HuggingFace의 "300 items" 표기가 서로 일치한다.
개별 문항 하나하나를 300개까지 전수 카운트하지는 않았다 — 배포처 확인이라는 이번
조각의 범위(입수 가부 단정)에는 필요하지 않다고 판단했다.

## 비범위 확인

이 문서는 배포처 확인 결과만 기록한다. 데이터셋 실제 다운로드, 어댑터 구현,
문항을 mori 자체 시나리오 형식으로 변환하는 작업은 이 조각의 범위가 아니다
(#432 비범위 절 참조). `packages/` 아래 코드 변경 없음.
