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
| 音声スコープ | 周波数表示の左。復調後の音声のスペクトラムに、フィルタの通過帯域を網掛けで重ねる |
| 情報行 | モード（クリックで切り替え）、ST（ステレオ受信中）、フィルタ（FIL1〜3 と帯域幅）、ステップ、AGC、ゲイン、サンプルレート、SQL、TX（送信中）、◐（配色をシアン / アンバーに切り替え）、時計 |
| モードキー | 周波数表示の下。NFM / WFM / AM / USB / LSB / CW |
| バンドキー | ダイヤルの左。FM / AIR / 50 / 144 / 430 / 1200 / 2400 / 5600（50 は 70 MHz 未満で受信できないため無効） |
| メインダイヤル | ドラッグで回す、またはホイール。1 回転 50 ステップ、時計回りで周波数が上がる。勢いよく回すと惰性で回り続ける |
| ダイヤル周りのキー | FINE / FAST で同調ステップ（10 Hz〜100 kHz）を 1 段ずつ小さく / 大きく、AUTO は速く回したときステップを 10 倍、FIL でフィルタを FIL1 → FIL2 → FIL3 と切り替え |
| フィルタ | モードごとに 3 つ。SSB 3.0k / 2.4k / 1.8k（100 Hz ローカット）、CW 1.2k / 500 / 250、AM 9k / 6k / 3k、NFM 15k / 10k / 7k、WFM 200k / 150k / 100k。帯域幅を変えると選択中の FIL に記憶する |
| AF / SQL つまみ | 上下ドラッグかホイールで音量 / スケルチ。SQL は左いっぱいで OFF |

### スペクトラム / ウォーターフォール

| 操作 | 動作 |
|---|---|
| クリック | その周波数に同調 |
| ドラッグ | 表示範囲を横スクロール（カーソル位置の周波数は固定） |
| 帯域の端をドラッグ | 帯域幅を変更（選択中の FIL に記憶） |
| ホイール（Shift で ×10）、← → キー | ステップ単位で同調 |
| Ctrl + ホイール、右端のスライダー | ズーム |
| 境界をドラッグ（ダブルクリックで初期値） | スペクトラムとウォーターフォールの高さを変更 |
| Space | 送信（押している間）。CW では電鍵 |
| Enter | 受信開始 / 停止 |

### 機能

- 復調: WFM（ステレオ対応、パイロット検出で ST 点灯）/ NFM / AM / USB / LSB / CW（キャリアを 700 Hz の音で再生、帯域 100 Hz〜3 kHz）。スケルチ、デエンファシス 50 / 75 µs
- バンドキー:
  - 144 / 430 / 1200 / 2400 / 5600 は日本のアマチュアバンドで、NFM・20 kHz ステップ
  - バンドごとに最後の周波数とモードを記憶する
- S メーター:
  - dBm は「dBFS − RX ゲイン + 補正値」で換算する。S9 = −93 dBm（VHF/UHF の慣例）、S 1 つ = 6 dB
  - 正確な値が必要なら、既知のレベルの信号を入れてサイドバーの **S-meter cal** で合わせる
- 周波数補正: サイドバーの **Freq. corr.**（ppm）で Pluto の水晶の誤差を補正する。ずれ(Hz) ÷ 周波数(MHz) = ppm
- Wideband scan: 20 MSPS・16 MHz ステップで指定範囲を掃引する（約 7 ms/ステップ）。結果をクリックすると、その周波数で受信を始める
- 受信範囲は 70 MHz〜6 GHz（AD9364 の仕様。70 MHz 未満を受けるにはアップコンバーターが必要）
- サンプルレート: USB 2.0 の実効上限が約 8 MSPS なので、連続受信は 6 MSPS 以下を推奨。7.68 MSPS では音が途切れることがある

### 送信

サイドバーの **Transmit** で「送信を有効にする」にチェックすると使える（初回だけ免許・法令の確認がある）。

- PTT: Space キーかサイドバーの **PTT** ボタンを押している間送信する。ウィンドウからフォーカスが外れると止まる
- モード: NFM（偏移 ±5 kHz）/ AM / USB / LSB（選択中の FIL の帯域、100 Hz ローカット）/ CW
- CW: Space が縦振れ電鍵。キーのタイミングを保ったまま送信し（約 80 ms 遅れ）、最後にキーを離してから 0.8 秒で受信に戻る（セミブレークイン）。700 Hz のサイドトーンが鳴る
- 送信できる範囲: 日本のアマチュアバンド 144–146 / 430–440 / 1260–1300 / 2400–2450 / 5650–5850 MHz。電波の幅（NFM ±8 kHz、AM ±3 kHz、SSB はフィルタ幅、CW ±250 Hz）がバンドに収まるときだけ送信する。WFM は送信不可
- 出力: **TX level**（TX 減衰量 0〜−89.75 dB）。0 dB で約 +7 dBm。起動時は −30 dB
- マイク: **Mic gain** で調整。300 Hz ハイパスとソフトクリップの後、帯域制限してから変調する。送信中は音声スコープにマイク入力を表示し、受信音は消音する
- タイムアウトタイマー: 3 分で自動的に送信を止める
- 送信中は情報行の **TX** とダイヤルの LED が赤く点灯する
- 送信しないときは、TX LO を止め、DDS を切り、減衰量を最大にしておく（Pluto は起動時に DDS のテスト信号を出す設定になっているため）
- 送信 LO は VFO の周波数に置くので、SSB ではキャリアの漏れが少し残る
- 送信中は USB で送受信の両方のデータを流すので、サンプルレートは 2.4 MSPS 前後を推奨（6 MSPS 以上では送信が途切れる）

**注意**: 実際に電波を出すには、アマチュア無線局の免許を受け、この Pluto を無線設備として登録する必要がある。Pluto の出力にはスプリアスや高調波が含まれるので、外付けの LPF / BPF を必ず入れること。アプリの制限は誤送信を防ぐ補助で、法令への適合を保証するものではない。

## 前提

Pluto は `fw_setenv attr_val ad9364`（Rev.B）で 70 MHz〜6 GHz に拡張済みであることを前提にしている。AD9363 のままだと 325 MHz〜3.8 GHz に制限される（接続時に表示される）。

## 構成

```
src/pluto.js          WebUSB 上の IIOD プロトコル（libiio USB バックエンド相当）
src/dsp.js            FFT・FIR・デシメーション・復調・ステレオ PLL・リサンプラ
src/worker.js         DSP ワーカー（スペクトラム + 音声）
src/tx-worker.js      送信ワーカー（マイク / 電鍵 → 変調 → I/Q）
src/audio-worklet.js  音声出力（リングバッファ）とマイク入力
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
node tools/test-tx.mjs       # 実機で送信経路を検証（最小出力 −89.75 dB、430 MHz 帯）
node tools/test-dsp.mjs      # 合成信号で復調・変調を検証
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
