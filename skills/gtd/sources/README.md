# 업무 도구

업무 도구 하나가 폴더 하나입니다. `sources/<이름>/SOURCE.md` 와 그 도구에 필요한 스크립트가 들어 있습니다. gtd 스킬(scan·tomorrow·review)은 도구 이름을 모르고, 켠 도구의 SOURCE.md 칸만 부릅니다. 캘린더는 도구가 아니라 nod 에 들어 있습니다(`nod today`).

## 켜기와 끄기

켠 도구는 nod 홈의 `config.json`(`~/.nod/config.json`) 에 있는 `sources` 목록입니다.
- 켜기: 그 도구 SOURCE.md 의 "설치"를 따릅니다. 확인 명령이 통과하면 목록에 이름을 더합니다. 사용자가 할 일(로그인·권한 허용)은 `!` 한 줄로 안내합니다.
- 끄기: 목록에서 이름을 지웁니다. 도구 쪽 설치는 그대로 둡니다.

## SOURCE.md 의 칸

| 칸 | 내용 | 부르는 곳 |
|---|---|---|
| 설치 | Claude 가 실행할 명령, 사용자가 `!` 로 칠 한 줄, 확인 명령, config.json 에 넣을 값 | 켜기 |
| 모으기 | 무엇이 할 일 후보인가, 원본 ID(`--key`)로 쓸 값, 넣은 뒤 할 일 | gtd:scan 의 훑기 |
| 끝남 | 무엇을 보면 그 일이 끝난 것인가. 메신저처럼 다른 도구의 일에 대한 답이 오는 곳이면, 식별자(`ENG-12`)를 그대로 검색하는 법과 그 일의 상대와 나눈 글을 찾는 법도 씁니다 | gtd:scan 의 훑기·끝난 일 정리 |
| 다가오는 것 | 정해진 기간의 마감과 일정 | gtd:tomorrow, gtd:review |

해당하지 않는 칸은 두지 않습니다. 스크립트는 SOURCE.md 옆에 두고 `<gtd 폴더>/sources/<이름>/...` 경로로 부릅니다. gtd 폴더는 [ledger.md](../ledger.md) 가 있는 폴더입니다. 스크립트는 config.json 을 [config.ts](config.ts) 로 읽습니다.

## 지금 있는 도구

| 이름 | 읽는 것 |
|---|---|
| [slack](slack/SOURCE.md) | "나중에" 저장, 나에게 보낸 메시지(휴대폰 받아 적기), 최근 멘션(읽음 무관)·안 읽은 DM·알림 DM, 스레드 회신 |
| [plane](plane/SOURCE.md) | 나에게 배정된 이슈, 내가 만들어 남에게 맡긴 이슈와 그 마지막 댓글, 이슈에 댓글 남기기 |
| [linear](linear/SOURCE.md) | 나에게 배정된 이슈와 알림 |
| [github](github/SOURCE.md) | 리뷰 요청, 내가 연 PR |
| [forgejo](forgejo/SOURCE.md) | 리뷰 요청, 내가 연 PR, 내가 맡은 레포의 CI |

## 새 도구 더하기

1. `sources/<이름>/SOURCE.md` 를 만들고 위 칸 중 해당하는 것을 채웁니다. 비슷한 도구(예: github)를 본보기로 삼습니다.
2. 도구별 값(주소·조직 등)은 SOURCE.md 에 쓰지 않고 config.json 의 `<이름>` 칸에서 읽습니다. 스크립트가 읽는 칸이면 config.ts 의 모양에 더합니다.
3. 이 레포는 공개 레포입니다. 회사 이름·사내 주소 같은 값은 넣지 않습니다([public-repo](../../../.claude/rules/public-repo.md)).
4. 위 "지금 있는 도구" 표에 한 줄 더합니다.
