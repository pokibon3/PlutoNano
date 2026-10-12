# Pluto Nano SDR

ADALM-Pluto 専用の、SDR++ を参考にしたブラウザ SDR。サーバー不要で、`dist/PlutoNano.html` を Chrome / Edge で開くだけで動く（WebUSB で Pluto と直接通信）。

## 使い方

1. Pluto を USB で接続する（`iio_info` や `screen` など他のアプリが掴んでいないこと）
2. `dist/PlutoNano.html` を Chrome で開く
3. **Connect** → デバイス選択 → **▶** で受信開始

| 操作 | 動作 |
|---|---|
| スペクトラム / ウォーターフォールをクリック | 同調 |
| VFO をドラッグ / 帯域の端をドラッグ | 周波数移動 / 帯域幅変更 |
| ホイール（Shift で ×10）、← → キー | Snap 単位で同調 |
| Ctrl + ホイール、右端スライダー | ズーム |
| 周波数表示の桁をホイール / クリック、ダブルクリック | 桁ごとに変更 / 直接入力（`82.5`, `433.92M`, `1.2G`） |
| メインダイヤルをドラッグで回す / ホイール | STEP 単位で同調（1 回転 50 ステップ、勢いよく回すと惰性で回転） |
| STEP ボタン | 同調ステップ切り替え（10 Hz〜100 kHz）。FINE で 1/10、AUTO は速く回すと 10 倍 |
| AF / SQL つまみ（上下ドラッグ / ホイール） | 音量 / スケルチ（SQL は左いっぱいで OFF） |
| S メーターをクリック | 針 / バー表示の切り替え |
| 情報行のモード表示をクリック / ◐ | モード切り替え / 配色（シアン・アンバー）切り替え |
| Space | 受信開始 / 停止 |

- 復調: WFM（ステレオ対応、パイロット検出で ST 点灯）/ NFM / AM / USB / LSB / CW（キャリアを 700 Hz の音で再生、帯域 100 Hz〜3 kHz）（スケルチ、デエンファシス 50/75 µs）
- バンドボタン: FM / AIR / 144 / 430 / 1200 / 2400 / 5600（日本のアマチュアバンド、NFM・20 kHz ステップ）/ 2.4G / 5G。バンドごとに最後の周波数を記憶し、Wideband scan の範囲もそのバンドに合わせる
- 無線機風のフロントパネル: S メーター（dBm 換算は dBFS − ゲイン + 補正値、S9 = −93 dBm。Source の S-meter cal で校正）、7 セグメント周波数表示、バンドスイッチ、STEP ボタン、メインダイヤル
- スペクトラムとウォーターフォールの境界はドラッグで変更（ダブルクリックで初期値）
- Wideband scan: 20 MSPS・16 MHz ステップで指定範囲を掃引（約 7 ms/ステップ）。結果をクリックするとその周波数で受信開始
- USB 2.0 の実効上限は約 8 MSPS のため、連続受信は 6 MSPS 以下を推奨

## アプリとして使う（PWA）

https://pokibon3.github.io/PlutoNano/ を Chrome で開き、タイトルバーの **Install**（またはアドレスバーのインストールアイコン）を押すと、独立したウィンドウのアプリとしてインストールされる。一度開けばオフラインでも起動する。

- `npm run build` が `docs/`（GitHub Pages 用: ページ、manifest、service worker、アイコン）も生成する
- アイコンは `pwa/icon.svg` を編集して `node tools/make-icons.mjs` で PNG を作り直す

## 構成

```
src/pluto.js          WebUSB 上の IIOD プロトコル（libiio USB バックエンド相当）
src/dsp.js            FFT・FIR・デシメーション・復調・リサンプラ
src/worker.js         DSP ワーカー（スペクトラム + 音声）
src/audio-worklet.js  音声出力（リングバッファ）
src/app.js            UI・描画・スキャン
tools/build.mjs       src/* を 1 ファイルの dist/PlutoNano.html にまとめる
```

## 開発

```sh
npm install              # node-usb（実機テスト用）
npm run build            # dist/PlutoNano.html を生成
npm run test:usb         # 実機で pluto.js を検証（Node + node-usb）
node tools/test-dsp.mjs  # 合成信号で復調を検証
node tools/browser-check.mjs shot.png --mock   # ヘッドレス Chrome + 擬似 Pluto で画面確認
```

Pluto は `fw_setenv attr_val ad9364`（Rev.B）で 70 MHz〜6 GHz に拡張済みであることを前提にしている。
