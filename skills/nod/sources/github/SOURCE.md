# GitHub

`gh` CLI 로 PR 을 읽습니다.

## 설치

- Claude: `brew install gh`
- 사용자: `! gh auth login`
- 확인: `gh auth status`

## 모으기

최근 30일 안에 움직인 열린 PR 만 봅니다. 그보다 오래 멈춘 PR 은 사용자가 따로 물을 때만 봅니다. 원본 ID 는 PR 주소입니다(`--source github --key <PR 주소>`).

- 나를 직접 리뷰어로 지정한 PR:
  `gh search prs --state=open "user-review-requested:@me" --updated ">=$(date -v-30d +%F)" --json repository,number,title,url,updatedAt`
  팀으로만 지정된 PR 은 대개 내 리뷰가 필요 없어 이 검색에 들어오지 않습니다.
- 내가 연 PR:
  `gh search prs --state=open --author=@me --updated ">=$(date -v-30d +%F)" --json repository,number,title,url,updatedAt`
  대기 할 일입니다. 상태 `waiting`, `--waiting-on` 은 리뷰어입니다. 오래 멈춘 것은 재촉할지 묻습니다.

## 끝남

- PR 이 머지됐거나 닫혔으면(`gh pr view <url> --json state`) 그 PR 을 기다리던 할 일이나 리뷰 할 일은 끝난 것입니다.
