# Forgejo

Forgejo(또는 Gitea)의 PR 과 내가 맡은 레포의 CI 를 `tea` CLI 로 읽습니다.

## 설치

- Claude: `brew install tea`
- 사용자: `! tea login add --name <이름> --url <Forgejo 주소> --token <토큰>`. 토큰 범위는 repository 읽기와 user 읽기면 됩니다.
- config.json 에 넣을 값:
  ```json
  "forgejo": { "org": "<훑을 조직>", "maintainerFile": "<맡은 사람을 적는 파일>", "maintainerKey": "<그 파일의 키>" }
  ```
  레포 안 `maintainerFile` 에 `<maintainerKey>: <내 아이디>` 줄이 있으면 내가 맡은 레포로 봅니다(예: `project.yaml` 의 `maintainer: alice`). 두 값이 없으면 그 칸은 건너뜁니다.
- 확인: `bun <스킬 폴더>/sources/forgejo/forgejo.ts` 가 오류 없이 출력하면 됩니다.

## 모으기

`bun <스킬 폴더>/sources/forgejo/forgejo.ts` 를 실행합니다. 원본 ID 는 PR 주소입니다(`--source forgejo --key <PR 주소>`).
- 리뷰 후보는 나를 직접 리뷰어로 지정한 PR 뿐입니다. 스크립트가 팀으로만 지정된 PR 은 걸러 냅니다.
- 내가 연 열린 PR 은 대기 할 일입니다. 상태 `waiting`, `--waiting-on` 은 리뷰어입니다. 오래 멈춘 것은 재촉할지 묻습니다.
- 내가 맡은 레포는 기본 브랜치 CI 실패를 후보로 둡니다. 다른 사람이 연 PR 은 나를 직접 지정했을 때만 리뷰 후보입니다. 이 칸의 "review requested" 에는 이미 리뷰를 남긴 사람도 남아 있으므로, 리뷰할 차례인지는 위의 "나를 직접 리뷰어로 지정한 PR" 목록으로 판단합니다.
- 이슈와 PR 이 같은 일이면 PR 상태를 믿습니다.

## 끝남

- PR 이 머지됐거나 닫혔으면 그 PR 을 기다리던 할 일이나 리뷰 할 일은 끝난 것입니다.
