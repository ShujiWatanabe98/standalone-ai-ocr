# Standalone AI OCR

患者登録、評価シート画像の取込、非同期AI OCR、結果修正・確定、履歴回覧を提供する単体版です。Node.js 18以上だけで起動できます。

```powershell
# リポジトリ直下の standalone-ai-ocr.local.env に記入
# OPENAI_API_KEY=sk-...
.\start-standalone-ai-ocr.ps1
```

ブラウザで `http://127.0.0.1:8795/` を開きます。
本番環境では必須環境変数を検査する `.\start-standalone-ai-ocr-production.ps1` を使用します。

## 設定

- `OPENAI_API_KEY`: 必須。リポジトリへ保存しないこと
- `OPENAI_MODEL`: 既定値 `gpt-5.6-sol`
- `AIOCR_PORT`: 既定値 `8795`
- `AIOCR_HOST`: 既定値 `127.0.0.1`
- `AIOCR_DATA_DIR`: 患者、OCR結果、画像の保存先
- `AIOCR_USERNAME`, `AIOCR_PASSWORD`: Basic認証。ローカル外へバインドする場合は必須
- `AIOCR_FACILITY_ID`: 施設分離用ID
- `AIOCR_ENCRYPTION_KEY`: 32文字以上。DBと原画像のAES-256-GCM暗号化
- `AIOCR_BACKUP_DIR`: バックアップ保存先
- `AIOCR_IMAGE_RETENTION_DAYS`: 確定済み原画像の保持日数。`0` は自動削除なし

`AIOCR_HOST=0.0.0.0` など外部から到達可能なアドレスを指定すると、認証情報が未設定の場合は起動を拒否します。実運用ではHTTPSリバースプロキシの背後で使用してください。

## バックアップと復元

`POST /api/admin/backup` で暗号化済みDBと原画像のスナップショットを作成します。復元はサーバー停止中に実行します。

```powershell
node .\standalone\scripts\restore-backup.mjs <backup-directory> <data-directory> --confirm-restore
```

この実装はローカルMVPです。外部販売・本番運用前に、組織認証、施設分離、暗号化、バックアップ、契約・法務確認を完了してください。

## Renderでのデモ公開

リポジトリ直下の `render.yaml` をBlueprintとしてRenderへ登録すると、`onrender.com` のHTTPS URLで起動できます。Render側で `OPENAI_API_KEY`、`AIOCR_USERNAME`、`AIOCR_PASSWORD` を秘密情報として設定してください。

無料プランの `/tmp` は永続ストレージではありません。再起動や再デプロイで患者・OCR履歴・画像が消えるため、デモデータ以外は登録しないでください。実患者データを扱う場合は、アクセス制御済みの永続ストレージ、別系統バックアップ、組織承認を備えた本番構成へ移行してください。
