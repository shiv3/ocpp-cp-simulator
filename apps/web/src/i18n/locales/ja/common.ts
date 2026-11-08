import type { Messages } from "../../types";

const common: Messages = {
  "common.language.toggle": "言語を変更",
  "common.theme.toggle": "テーマを切り替え",
  "common.theme.light": "ライト",
  "common.theme.dark": "ダーク",
  "common.theme.system": "システム",
  "common.nav.chargePoints": "充電器",
  "common.nav.scenarios": "シナリオ",
  "common.nav.runHistory": "実行履歴",
  "common.nav.messageLog": "メッセージログ",
  "common.nav.settings": "設定",
  "common.sidebar.expand": "サイドバーを開く",
  "common.sidebar.collapse": "サイドバーを閉じる",
  "common.mode.local": "ローカルモード",
  "common.mode.remote": "リモートモード",
  "common.mode.localTooltip":
    "ローカルモード: シミュレーターはこのブラウザー内で動作します",
  "common.health.checkingAria": "リモート接続: 確認中",
  "common.health.okAria": "リモート接続: 接続済み",
  "common.health.downAria": "リモート接続: 切断",
  "common.health.checkingReason": "確認中…",
  "common.health.okReason": "接続済み",
  "common.health.downReason": "デーモンに接続できません",
  "common.notFound.back": "← 充電器に戻る",
  "common.notFound.title": "ページが見つかりません",
  "common.notFound.nothingAt": "{path} には何もありません。",
  "common.settingsPage.networkSimulation": "ネットワークシミュレーション",
  "common.settingsPage.loadFailed":
    "ネットワークシミュレーション設定の読み込みに失敗しました",
  "common.build.ui": "UI {version}",
  "common.build.uiTitle": "この Web コンソールのバージョン",
  "common.build.daemon": "デーモン {version}",
  "common.build.daemonTitle": "接続中のデーモンのバージョン",
  "common.vehicle.field.usableBatteryKwh": "使用可能バッテリー容量",
  "common.vehicle.field.acMaxKw": "AC 最大出力",
  "common.vehicle.field.acPhases": "AC 相数",
  "common.vehicle.field.dcMaxKw": "DC 最大出力",
  "common.vehicle.savedProfiles": "保存済みプロファイル",
  "common.vehicle.savedProfilesUnavailable":
    "保存済みプロファイルを利用できません: {error}",
  "common.vehicle.notesAria": "車両プロファイルの注記",
  "common.vehicle.optionMissing": "{name} · {type} ({fields}が未設定)",
  "common.vehicle.phasesShort": "{count} 相",
  "common.vehicle.curve": "カーブあり",
  "common.vehicle.noCurve": "カーブなし",
  "common.vehicle.profileGone": "この車両プロファイルはもう存在しません。",
  "common.vehicle.unusableMissing":
    "{name} は {type} に使用できません: {fields}が未設定です。設定 → 車両プロファイルで入力してください。",
  "common.vehicle.unusableCurve":
    "{name} にはシミュレーターで使用できない DC カーブがあります: {detail}。",
  "common.vehicle.warn.powerAboveDcMax":
    "カーブのピークは {peakKw} kW で、申告された DC 最大 {dcMaxKw} kW を超えています。カーブの点が失われないよう、最大値を {peakKw} kW に設定しました。",
  "common.vehicle.warn.curveCapped":
    "カーブのピークは {peakKw} kW で、設定した DC 最大 {dcMaxKw} kW を超えています。{dcMaxKw} kW に制限されます。",
  "common.vehicle.warn.curveStartsAboveZero":
    "カーブは SoC {soc} % から始まります。それ未満では最初の出力が維持されます。",
  "common.vehicle.warn.curveEndsBelowFull":
    "カーブは SoC {soc} % で終わります。それを超えると最後の出力が維持されます。",
  "common.vehicle.warn.noDcCurve":
    "DC カーブなし: 車両は最大出力で一定に充電します。",
  "common.vehicle.warn.unsupportedAcPhases":
    "ソースの AC 相数は {phases} ですが、シミュレーターは 1 または 3 のみ対応のため単相を使用します。",
  "common.vehicle.warn.acPhasesUnknown":
    "ソースに AC 相数がありません。単相と仮定します。",
  "common.vehicle.storeUnsupported":
    "このコンソールでは車両プロファイルを保存できません",
  "common.log.filterValues": "値を絞り込み",
  "common.log.filterGroupValues": "{title} の値を絞り込み",
  "common.log.none": "(なし)",
  "common.log.sent": "送信",
  "common.log.received": "受信",
  "common.log.sentArrow": "→ 送信",
  "common.log.receivedArrow": "← 受信",
  "common.log.chargePointZero": "0 (充電器)",
  "common.log.connectorN": "コネクター {id}",
  "common.log.filters": "フィルター",
  "common.log.chargePoint": "充電器",
  "common.log.level": "レベル",
  "common.log.type": "種別",
  "common.log.connector": "コネクター",
  "common.log.direction": "方向",
  "common.log.action": "アクション",
  "common.log.noChargePoints": "充電器はまだありません",
  "common.log.noConnectors": "コネクターの参照はまだありません",
  "common.log.noActions": "解析済みの OCPP アクションはまだありません",
  "common.log.filtersToggleTitle": "フィルターの表示/非表示",
  "common.log.logs": "ログ",
  "common.log.counts": "全 {total} 件 / 絞り込み {filtered} 件",
  "common.log.autoScroll": "自動スクロール",
  "common.log.download": "ダウンロード",
  "common.log.downloadTitle":
    "保存済みの全ログ行を JSON Lines ファイルとしてダウンロードします。",
  "common.log.clearScreen": "画面をクリア",
  "common.log.clearScreenTitle":
    "表示中のログ行を非表示にします。保存済みの履歴は残ります。",
  "common.log.clearAll": "画面と DB をクリア",
  "common.log.clearAllTitle":
    "表示中のログ行を非表示にし、保存済みのログ行も削除します。",
  "common.log.search": "メッセージ内を検索...",
  "common.log.details": "詳細",
  "common.log.timestamp": "タイムスタンプ",
  "common.log.message": "メッセージ",
  "common.log.noLogs": "ログはまだありません",
  "common.log.noMatch": "現在のフィルターに一致するログはありません",
  "common.log.hideDetails": "詳細を隠す",
  "common.log.showDetails": "詳細を表示",
  "common.time.never": "なし",
  "common.time.justNow": "たった今",
  "common.time.secondsAgo": "{count}秒前",
  "common.time.minutesAgo": "{count}分前",
  "common.time.hoursAgo": "{count}時間前",
  "common.time.daysAgo": "{count}日前",
  "common.catalog.unauthorizedLocal":
    "Open EV Directory が API キーを拒否しました。キーが未設定、無効、期限切れ、または失効しています。個人用キーを入力してください。",
  "common.catalog.unauthorizedRemote":
    "Open EV Directory がデーモンの API キーを拒否しました。キーが未設定、無効、期限切れ、または失効しています。デーモンに OED_API_KEY を設定してください。",
  "common.catalog.rateLimitedIn":
    "Open EV Directory のレート制限に達しました。{seconds} 秒後にもう一度お試しください。",
  "common.catalog.rateLimited":
    "Open EV Directory のレート制限に達しました。しばらくしてからもう一度お試しください。",
  "common.catalog.networkLocal":
    "Open EV Directory に接続できません。オフラインか、API がこのページからの呼び出しを許可していない (CORS) 可能性があります。代わりにデーモン経由でインポートしてください (--oed-base-url と OED_API_KEY を付けて起動)。",
  "common.catalog.networkRemote":
    "Open EV Directory に接続できません: {message}",
  "common.catalog.timeout":
    "Open EV Directory が時間内に応答しませんでした。もう一度お試しください。",
  "common.catalog.notFound": "Open EV Directory に見つかりません: {message}",
  "common.catalog.notConfiguredLocal":
    "先に Open EV Directory の URL を入力してください。",
  "common.catalog.notConfiguredRemote":
    "デーモンで車両インポートが無効になっています (--oed-base-url none または OED_BASE_URL=none)。",
  "common.payloadCondition": "ペイロード条件",
};
export default common;
