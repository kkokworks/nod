# Slack

Slack MCP 서버의 도구로 읽습니다.

## 설치

- 필요한 것: `saved_list`·`saved_update`·`conversations_unreads`·`conversations_history`·`conversations_search_messages`·`users_search` 도구를 주는 Slack MCP 서버. 이 PC 에 로컬로 설치해 Claude Code 에 등록합니다.
- 사용자: Slack 토큰은 MCP 서버 설정에 직접 넣습니다. 대화에 붙이지 않습니다.
- config.json 의 `slack` 에 넣을 값:
  ```json
  "slack": { "selfId": "<내 사용자 ID>", "selfDm": "<나와의 DM 채널 ID>", "notifyDms": ["<알림 봇 DM 채널 ID>"] }
  ```
  - `selfId`: 나를 멘션한 메시지를 찾는 데 씁니다. 내가 보낸 아무 메시지의 `UserID` 입니다.
  - `selfDm`: 휴대폰 받아 적기용입니다. `channels_list` 의 DM 중 상대가 나인 것입니다.
  - `notifyDms`: 이슈 트래커 같은 도구가 새 댓글·멘션을 DM 으로 알려 주면, 그 봇과의 DM 채널입니다. 없으면 비웁니다.
- 확인: 이 세션의 도구 목록에 `conversations_search_messages` 가 있으면 됩니다.

## 모으기

1. 나에게 보낸 메시지: 밖에서 떠오른 일은 휴대폰 Slack 에서 나에게 보내 둡니다. `conversations_history` 로 `selfDm` 채널의 최근 14일 메시지를 읽고, 모두 후보로 둡니다. 키는 메시지 시각(`ts`)이라 `--source slack --key <ts>` 로 넣으면 다음 훑기에서 다시 들어오지 않습니다.
2. "나중에" 저장(`saved_list`): 사용자가 직접 저장한 것이라 모두 후보입니다. 키는 메시지 주소입니다.
3. 나를 부른 메시지: 최근 7일 동안 나를 멘션한 메시지를 읽음 여부와 관계없이 찾습니다(`conversations_search_messages`, `search_query: "<@selfId>"`, `filter_date_after: <7일 전>`). 사용자는 앱에서 먼저 열어 보는 일이 많아, 안 읽은 것(`conversations_unreads`)만 보면 처리하지 않은 요청이 빠집니다. 메시지마다 스레드(`conversations_replies`)를 읽어, 그 뒤에 사용자가 답했거나 상대가 스스로 정리했으면 뺍니다. 남은 것 중 사용자에게 무언가를 해 달라는 요청만 후보로 둡니다. 공유·인사·답이 필요 없는 말은 뺍니다. 멘션 없이 온 DM 은 안 읽은 DM(`conversations_unreads`, `channel_types: dm`)으로 봅니다.
4. 알림 DM: `notifyDms` 채널마다 `conversations_history` 로 최근 7일을 읽음 여부와 관계없이 읽습니다. 다른 사람이 내 이슈나 내가 부탁한 이슈에 단 댓글과 나를 부른 멘션이 여기 옵니다. 새 요청이면 후보로 두고, 장부의 열린 항목에 대한 답이면 "끝남"의 근거로 씁니다.
5. 넣은 뒤: "나중에" 항목을 장부에 넣었으면 Slack 에서 완료로 바꿀지 묻습니다(`saved_update`). 사용자가 원할 때만 바꿉니다.

## 끝남

- 항목이 생긴 뒤 사용자가 그 스레드에 답했으면 회신 항목은 끝난 것입니다.
- 상대가 확인·완료를 알렸으면("값이 일치합니다", "폐기했습니다") 그 일을 기다리던 항목도 끝난 것입니다.
- 항목에 스레드 링크가 없으면 제목·메모에 있는 식별자(`<레포>#40`, `ENG-12`)를 그대로 검색어로 써서 `conversations_search_messages` 로 찾습니다. 주제 낱말로 바꿔 짐작해 찾지 않습니다.
- 식별자 없이 끝나는 일도 많으니 그 일의 상대와 나눈 글도 찾습니다. `users_search` 로 상대 ID 를 찾고, `conversations_search_messages` 에 `filter_users_from: <selfId>`·`filter_users_with: <상대 ID>`·`filter_date_after: <14일 전>` 을 줍니다. 채널 스레드와 DM 이 함께 나옵니다.
- 대기 항목은 대기로 둔 뒤(`statusAt`) 상대가 남긴 말이 있는지 "모으기" 3·4번 결과에서도 찾습니다. 답은 링크와 다른 곳(PR 일인데 이슈 댓글, 이슈 일인데 채널 스레드)에 오는 일이 많습니다.
- 일부만 답했을 수 있으므로, 사람 없이 돌 때는 이 근거만으로 완료하지 않고 남겨 둡니다.

## 다가오는 것

- "나중에" 저장 중 기한이 그 기간 안인 것.
