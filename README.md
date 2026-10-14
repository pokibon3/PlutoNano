# Pluto Nano SDR

ADALM-Pluto（Pluto Nano）専用の、ブラウザで動く SDR 受信機。WebUSB で Pluto と直接通信するので、サーバーもドライバのインストールも要らない。画面は SDR++ を参考にし、操作部は ICOM の無線機風にしている。

**アプリ: https://pokibon3.github.io/PlutoNano/**

![画面](docs/screenshot.png)

## 使い方

1. Pluto を USB で接続する（`iio_info` や `screen` など他のアプリが掴んでいないこと）
2. Chrome / Edge で https://pokibon3.github.io/PlutoNano/ を開く（ローカルの `dist/PlutoNano.html` でもよい）
3. **Connect** → 一覧から Pluto を選ぶ。接続すると自動で受信を始める
4. 最初の 1 回だけ、画面をクリックすると音が出る（ブラウザの自動再生制限のため）

2 回目以降は、ページを開くと許可済みの Pluto に自動で接続する。

### アプリとしてインストール（PWA）

上の URL を Chrome で開き、タイトルバーの **Install**、またはアドレスバー右端のインストールアイコンを押す。出ないときは Chrome の **︙** → **キャスト、保存、共有** → **ページをアプリとしてインストール**。

- 独立したウィンドウで開き、Dock / スタートメニューから起動できる
- 一度開けばオフラインでも起動する
- 新しい版が公開されると、起動時に自動で再読み込みして更新される
- アンインストールはアプリのウィンドウ右上の **︙** から

### 動作環境

WebUSB が必要なので、Chromium 系ブラウザ（Chrome / Edge）でのみ動く。

| 環境 | 状況 |
|---|---|
| macOS + Chrome / Edge | 動作確認済み |
| Windows + Chrome / Edge | 未確認。Pluto の IIO インターフェースに WinUSB ドライバが割り当たっている必要がある |
| Linux + Chrome / Edge | 未確認。一般ユーザーで USB にアクセスできるよう udev ルールが必要 |
| ChromeOS | 未確認（WebUSB・PWA とも対応している） |
| Android + Chrome | 未確認。USB OTG 接続で WebUSB が使える可能性がある |
| iPhone / iPad、Safari、Firefox | 動かない（WebUSB 非対応） |

## 画面と操作

### フロントパネル

| 部品 | 操作 |
|---|---|
| S メーター | IC-7300 風のアナログメーター（S / dBm / dBFS の 3 目盛り）。クリックでバー表示に切り替え |
| 周波数表示 | 桁をホイール / クリック（上半分で＋、下半分で−）で変更、ダブルクリックで直接入力（`82.5`, `433.92M`, `1.2G`） |
| 情報行 | モード（クリックで切り替え）、ST（ステレオ受信中）、帯域幅、ステップ、AGC、ゲイン、サンプルレート、SQL、◐（配色をシアン / アンバーに切り替え）、時計 |
| モードキー | NFM / WFM / AM / USB / LSB / CW |
| バンドキー | FM / AIR / 144 / 430 / 1200 / 2400 / 5600 / 2.4G / 5G |
| STEP キー | 10 Hz〜100 kHz。FINE でステップの 1/10、AUTO は速く回したとき 10 倍 |
| メインダイヤル | ドラッグで回す、またはホイール。1 回転 50 ステップ、時計回りで周波数が上がる。勢いよく回すと惰性で回り続ける |
| AF / SQL つまみ | 上下ドラッグかホイールで音量 / スケルチ。SQL は左いっぱいで OFF |

### スペクトラム / ウォーターフォール

| 操作 | 動作 |
|---|---|
| クリック | その周波数に同調 |
| ドラッグ | 表示範囲を横スクロール（カーソル位置の周波数は固定） |
| 帯域の端をドラッグ | 帯域幅を変更 |
| ホイール（Shift で ×10）、← → キー | ステップ単位で同調 |
| Ctrl + ホイール、右端のスライダー | ズーム |
| 境界をドラッグ（ダブルクリックで初期値） | スペクトラムとウォーターフォールの高さを変更 |
| Space | 受信開始 / 停止 |

### 機能

- 復調: WFM（ステレオ対応、パイロット検出で ST 点灯）/ NFM / AM / USB / LSB / CW（キャリアを 700 Hz の音で再生、帯域 100 Hz〜3 kHz）。スケルチ、デエンファシス 50 / 75 µs
- バンドキー:
  - 144 / 430 / 1200 / 2400 / 5600 は日本のアマチュアバンドで、NFM・20 kHz ステップ
  - バンドごとに最後の周波数とモードを記憶する
  - 2.4G / 5G は Wi-Fi バンドを Wideband scan で掃引し、チャンネル番号を表示する
- S メーター:
  - dBm は「dBFS − RX ゲイン + 補正値」で換算する。S9 = −93 dBm（VHF/UHF の慣例）、S 1 つ = 6 dB
  - 正確な値が必要なら、既知のレベルの信号を入れてサイドバーの **S-meter cal** で合わせる
- 周波数補正: サイドバーの **Freq. corr.**（ppm）で Pluto の水晶の誤差を補正する。ずれ(Hz) ÷ 周波数(MHz) = ppm
- Wideband scan: 20 MSPS・16 MHz ステップで指定範囲を掃引する（約 7 ms/ステップ）。結果をクリックすると、その周波数で受信を始める
- 受信範囲は 70 MHz〜6 GHz（AD9364 の仕様。70 MHz 未満を受けるにはアップコンバーターが必要）
- サンプルレート: USB 2.0 の実効上限が約 8 MSPS なので、連続受信は 6 MSPS 以下を推奨。7.68 MSPS では音が途切れることがある

## 前提

Pluto は `fw_setenv attr_val ad9364`（Rev.B）で 70 MHz〜6 GHz に拡張済みであることを前提にしている。AD9363 のままだと 325 MHz〜3.8 GHz に制限される（接続時に表示される）。

## 構成

```
src/pluto.js          WebUSB 上の IIOD プロトコル（libiio USB バックエンド相当）
src/dsp.js            FFT・FIR・デシメーション・復調・ステレオ PLL・リサンプラ
src/worker.js         DSP ワーカー（スペクトラム + 音声）
src/audio-worklet.js  音声出力（リングバッファ）
src/app.js            UI・フロントパネル・描画・スキャン
src/index.html        画面
src/style.css         スタイル
pwa/                  PWA 用の manifest、service worker、アイコン
tools/build.mjs       dist/PlutoNano.html（1 ファイル版）と docs/（GitHub Pages 版）を生成
docs/                 GitHub Pages で公開される PWA（build で生成）
```

## 開発

```sh
npm install                  # node-usb（実機テスト用）
npm run build                # dist/PlutoNano.html と docs/ を生成
npm run test:usb             # 実機で pluto.js を検証（Node + node-usb）
node tools/test-dsp.mjs      # 合成信号で復調を検証
node tools/make-icons.mjs    # pwa/icon.svg から PNG アイコンを生成
node tools/browser-check.mjs shot.png --mock   # ヘッドレス Chrome + 擬似 Pluto で画面確認
```

`browser-check.mjs` の環境変数:

| 変数 | 内容 |
|---|---|
| `PAGE=URL` | 開くページ（既定は `dist/PlutoNano.html`） |
| `CLIP=x,y,w,h` | 指定範囲だけを 2 倍で撮る |
| `INSTALL=1` | PWA の manifest・インストール可否・service worker を確認 |
| `EVAL_FILE=path` | ページ内で JavaScript を実行して結果を表示 |

公開は `main` ブランチの `docs/` を GitHub Pages で配信している。`npm run build` してコミット・push すれば更新される。
