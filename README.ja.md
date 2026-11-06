[English](README.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Español](README.es.md)

# Get Things Done

**仕事とともに育つ、AIのための記憶。**

会議を記録し、変更を確認し、AIが仕事を進めるための背景情報を整えます。
Get Things Doneは、Claude Code、Codex、GitHub Copilot向けの、オープンソースでローカルファーストのタスク・情報管理ツールです。プロジェクト、意思決定、関係者、出力テンプレートを、エージェントが読めるファイルに保存します。

## はじめる

### デスクトップアプリ

[macOS・Windows版をダウンロード](https://github.com/geovanneb/get-things-done/releases/latest)。お使いのOSに合うインストーラーを選び、リリースノートをご確認ください。

### CLIとブラウザー

Node.js **20.19以降**が必要です（22または24を推奨）。

```bash
npm install -g @bertonha/getthingsdone
mkdir work-memory && cd work-memory
gtd init
gtd start
```

初期設定でAIツールを選ぶと、ブラウザーにローカルのダッシュボードが開きます。

## 使い方

1. プロジェクトの背景と関係者を登録します。
2. 会議を録音するか、録音・文字起こしを取り込みます。録音前に参加者へ説明し、同意を得てください。
3. 音声を文字起こしする前に、**Settings → Transcription**で音声モデルをダウンロードします。
4. AIが提案した変更を確認・承認し、必要な背景情報と結び付けてタスクを作成します。

ワークスペースとオフライン文字起こしにGet Things Doneのアカウントは不要です。AIによる分析やタスク実行には、ご自身のAIツールを使います。そのツールのアカウントや契約が必要な場合があります。変更の承認と成果物の確認はユーザーが行います。

## 表示言語

開発版では、OSまたはブラウザーの優先言語を自動判定し、**Settings → Appearance → Language**で変更できます。英語・日本語・ポルトガル語（ブラジル）・スペイン語（ラテンアメリカ）に対応する基盤を導入しています。現在の翻訳範囲はナビゲーションのラベル、見出し、外観設定の一部です。多くの画面、ネイティブメニュー、CLIはまだ英語です。公開リリースでの提供状況はリリースノートをご確認ください。

表示言語は、録音の言語やAIに依頼する成果物の言語とは別の設定です。

## ドキュメントと参加

- [詳しい紹介（英語）](README.md)
- [ユーザーガイド（英語）](docs/user-guide.md)
- [変更履歴](CHANGELOG.md)・[貢献方法](CONTRIBUTING.md)
- [不具合報告・機能提案](https://github.com/geovanneb/get-things-done/issues)・[セキュリティの報告](SECURITY.md)

翻訳の改善も歓迎します。Issueやスクリーンショットには、実際の業務情報ではなく架空のデータを使用してください。

[MITライセンス](LICENSE)。このページは英語版READMEの要約です。詳しい仕様は英語版をご参照ください。

<!-- English source: README.md at 50aada22b090215270d3cf6896ed41d9cfda11bb; concise introduction, not a full translation. -->
