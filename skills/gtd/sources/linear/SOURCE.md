# Linear

이슈 트래커입니다. 나에게 배정된 진행 중 이슈마다 장부에 다음 행동이 하나 있고, 그 할 일은 이슈가 속한 프로젝트(업무 묶음)에 둡니다([ledger.md](../../ledger.md) 의 원칙).

## 설치

- Claude: `claude plugin install linear@claude-plugins-official`
- 사용자: Claude Code 를 다시 시작하고 `/mcp` → linear → Authenticate.
- 확인: 이 세션의 도구 목록에 `list_issues` 가 있으면 됩니다.

## 모으기

- 나에게 배정된 진행 중·할 일 이슈(`list_issues`, assignee `me`)와 안 읽은 알림(`get_notifications`)을 봅니다.
- 이슈 키를 원본 ID 로 씁니다(`--source linear --key <키>`). 없으면 이슈를 읽고 다음 행동 하나와 넣을 프로젝트를 제안합니다.
- 이슈 내용은 옮기지 않고 링크만 답니다.

## 끝남

- 이슈가 Done 이나 Canceled 면 끝난 것입니다.
- 같은 일의 PR 이 있으면 PR 상태를 믿습니다. Linear 상태는 늦게 따라옵니다.

## 다가오는 것

- 나에게 배정된 이슈 중 마감이 그 기간 안인 것.
