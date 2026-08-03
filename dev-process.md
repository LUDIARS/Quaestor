# Dev process marker

このファイルが存在することで、 AI agent が `npm run dev:all` を background で起動可能。

- backend: `npm run dev` (tsx watch、 port 17400)
- web: `npm --prefix web run dev` (vite、 port 5117)
- 両方同時: `npm run dev:all` (concurrently)

ファイル更新で自動リロード。 port bind 失敗時は古い node プロセスを kill。
