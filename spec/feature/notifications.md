# アドバイザーの Discord 通知

各アドバイザー (補助金サジェスト / 投資・優待 / 配当) のアドバイスを **Discord Webhook** で push する。
双方向は不要なので bot ではなく webhook。 オンデマンド (ボタン) と定期 (worker) の両方に対応。

## 構成

```
DiscordNotifier (webhook POST)  ← URL は secret QUAESTOR_DISCORD_WEBHOOK_URL
advice-notifications.ts         各アドバイザー出力 → DiscordMessage (embed) + dedupKey
NotificationService             build → dedup 判定 → send  (force=オンデマンド / dedup=定期)
  ├ /v1/notify/invest      (オンデマンド)  investAdvisor.suggestions()
  ├ /v1/notify/portfolio   (オンデマンド)  portfolio.dividendCandidates()
  └ /v1/notify/subsidies   (オンデマンド)  suggestSubsidies(plan_id)  ※crawl+LLM
NotificationWorker (server.ts)  定期に上記 endpoint を dedup:true で叩く
NotificationState (JSON file)   channel ごとの最終送信 dedupKey (前回と同内容なら送らない)
```

## Webhook URL の登録

```
npm run secret -- set QUAESTOR_DISCORD_WEBHOOK_URL https://discord.com/api/webhooks/xxx/yyy
```

未設定なら通知は `disabled` (送信されず、 endpoint は `{disabled:true}` を返す)。

## 定期通知 (config `notifications`)

`quaestor.config.json`:

```json
"notifications": {
  "enabled": false,            // 定期 worker の master switch
  "intervalMs": 21600000,      // 6h
  "invest": true,
  "portfolio": true,
  "subsidies": { "enabled": false, "planId": null }
}
```

- `invest` / `portfolio` は DB キャッシュ読みで軽い → 既定 ON。
- `subsidies` は jGrants クロール + LLM が走るため重い → 既定 OFF。 `planId` を指定して有効化。
- 定期は **dedup**: 前回送信と同内容 (dedupKey 一致) なら送らないので、 6h ごとに同じ提案を再送しない。
- worker は webhook URL があり `enabled=true` のときのみ起動 (server.ts)。

## オンデマンド (web)

「投資/優待」「積立/資産」「補助金」各タブに「Discordに通知」ボタン (`NotifyDiscordButton`)。
こちらは dedup せず常に送る。 補助金は計画選択時のみ表示 (plan_id 必須)。

## 送信内容

各アドバイザーの上位 5 件を embed の fields に。 補助金は fit=high/medium のみ。 個人の口座番号等は送らない
(店名・会社名・補助金名・集計値のみ)。
