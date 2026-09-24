# Third-party components

mori의 원본 코드에는 [MIT](LICENSE)를 적용한다. 외부 구성 요소의 저작권과 라이선스는 각 권리자에게 남는다.
아래는 기준 lockfile에서 설치한 직접 런타임 의존성의 package.json 메타데이터 확인 결과다.

| 구성 요소                     | 확인 버전 | 선언 라이선스 | 원본                                                   |
| ----------------------------- | --------- | ------------- | ------------------------------------------------------ |
| @anthropic-ai/sdk             | 0.91.1    | MIT           | https://github.com/anthropics/anthropic-sdk-typescript |
| @earendil-works/pi-agent-core | 0.82.1    | MIT           | https://github.com/earendil-works/pi                   |
| @earendil-works/pi-ai         | 0.82.1    | MIT           | https://github.com/earendil-works/pi                   |
| better-sqlite3                | 12.11.1   | MIT           | https://github.com/WiseLibs/better-sqlite3             |
| write-file-atomic             | 7.0.1     | ISC           | https://github.com/npm/write-file-atomic               |

이 표는 전체 전이 의존성의 법적 감사를 대신하지 않는다.
의존성을 번들·재배포할 때에는 해당 배포물의 LICENSE·NOTICE를 함께 보존해야 한다.
프로젝트의 MIT는 외부 패키지와 데이터셋의 라이선스를 덮어쓰지 않는다.

LongMemEval 관련 다운로드 데이터는 해당 원본 배포 조건을 따른다.
로더·테스트용 fixture의 존재를 공식 데이터셋 전체에 대한 MIT 재허가로 읽지 않는다.
이 공개 정리에는 다운로드한 외부 데이터셋이나 node_modules를 포함하지 않는다.

`docs/inherited/`는 전신 프로젝트의 기록이며, 현재 구현 규격과 구분해 읽는다.
