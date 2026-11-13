# DROP_Bot

DROP 投稿の素案（写真＋コメント）をもとに、問いを 1 つずつ投げかけて、本人の言葉で投稿文を仕上げる対話型コーチです。
コーチングの方針は `DROP_Dashboard_Shinagawa1.0` の `drop_coach_with_sample.html`（DROP. Coach サンプル参照版）を引き継いでいます。

| 構成 | 場所 |
| --- | --- |
| 画面 | `index.html`（GitHub Pages） |
| API | `gas/DROP_BOT.gs`（Google Apps Script ウェブアプリ） |
| AI | Azure OpenAI（`gpt-6-luna`。DROP. Coach と同じデプロイ） |
| プロンプト | `prompt/drop_bot.md`（GAS が raw URL から読み込む。5 分キャッシュ） |
| サンプル投稿 | `json/sample_drop.json`（DROP_Dashboard_Shinagawa1.0 と同じ形式） |

## 会話の流れ

1. 画像とコメント（下書き）を入れて「コーチと話す」を押す（初回は名前と共有パスワードでログイン）
2. コーチが投稿を 4 パターン（A 心が動いた／B 人とつながった／C 会社・場所の印象／D その他）に分類し、良い点と最初の問いを返す
3. 利用者が答えるたびに、次の問いを 1 つ返す（上限 `MAX_QUESTIONS`、既定 3 問）。「わからない・スキップ」「ここまでで投稿案をつくる」も選べる
4. 下書きと回答の言葉だけで投稿案をつくる。書かれていない気持ちは足さず、足りない部分は【 】の空欄になる
5. 「もっと短く」などで投稿案を直せる。「コピー」「下書きに反映」で使う

- 画像（利用者の画像とサンプル投稿の画像）は最初の 1 回だけ AI に送り、以降は AI が作った画像の説明文を使う
- 会話はブラウザ（localStorage）に保存され、再読み込みしても「前回の会話に戻る」で再開できる
- `index.html?mock=1` で GAS を呼ばずに画面の動きだけ確認できる

## セットアップ

1. Apps Script で新規プロジェクト（例：`DROP_Bot_API`）を作り、`gas/DROP_BOT.gs` の内容を貼り付ける
2. プロジェクトの設定 > スクリプト プロパティに次を登録する
   - `APP_PASSWORD` … 画面で入力させる共有パスワード
   - `AZURE_API_KEY_LUNA` … Azure OpenAI の API キー（リポジトリには書かない）
   - `PROMPT_URL` … `https://github.com/obayashi-smartcity/DROP_Bot/blob/main/prompt/drop_bot.md`（raw URL でも可。リポジトリが非公開の場合は取得できないので、公開リポジトリか Gist に置く）
   - 任意：`LOG_SHEET_ID`（会話ログを書き込むスプレッドシート ID。`log` シートに 1 ターン 1 行で記録）、`MAX_QUESTIONS`、`DAILY_LIMIT` など（`DROP_BOT.gs` 冒頭のコメント参照）
3. エディタで `checkSetup()` → `testChat()` を実行して疎通を確認する
4. デプロイ > 新しいデプロイ > ウェブアプリ（実行ユーザー「自分」、アクセス「全員」）で公開し、`/exec` の URL を `index.html` の `CONFIG.GAS_URL` に入れる
5. GitHub Pages を有効にする

プロンプトを変えたときは、GitHub に push 後 5 分ほどで反映されます（すぐ反映したいときは GAS で `clearPromptCache()` を実行）。
