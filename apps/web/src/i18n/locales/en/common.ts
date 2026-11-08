const common = {
  "common.language.toggle": "Change language",
  "common.theme.toggle": "Toggle theme",
  "common.theme.light": "Light",
  "common.theme.dark": "Dark",
  "common.theme.system": "System",
  "common.nav.chargePoints": "Charge Points",
  "common.nav.scenarios": "Scenarios",
  "common.nav.runHistory": "Run History",
  "common.nav.messageLog": "Message Log",
  "common.nav.settings": "Settings",
  "common.sidebar.expand": "Expand sidebar",
  "common.sidebar.collapse": "Collapse sidebar",
  "common.mode.local": "Local mode",
  "common.mode.remote": "Remote mode",
  "common.mode.localTooltip": "Local mode: the simulator runs in this browser",
  "common.health.checkingAria": "Remote connection: checking",
  "common.health.okAria": "Remote connection: connected",
  "common.health.downAria": "Remote connection: disconnected",
  "common.health.checkingReason": "Checking…",
  "common.health.okReason": "Connected",
  "common.health.downReason": "Cannot reach the daemon",
  "common.notFound.back": "← Back to charge points",
  "common.notFound.title": "Page not found",
  "common.notFound.nothingAt": "Nothing lives at {path}.",
  "common.settingsPage.networkSimulation": "Network Simulation",
  "common.settingsPage.loadFailed":
    "Failed to load network simulation configuration",
  "common.build.ui": "ui {version}",
  "common.build.uiTitle": "Version of this web console",
  "common.build.daemon": "daemon {version}",
  "common.build.daemonTitle": "Version of the connected daemon",
  "common.vehicle.field.usableBatteryKwh": "usable battery capacity",
  "common.vehicle.field.acMaxKw": "AC maximum power",
  "common.vehicle.field.acPhases": "AC phases",
  "common.vehicle.field.dcMaxKw": "DC maximum power",
  "common.vehicle.savedProfiles": "Saved profiles",
  "common.vehicle.savedProfilesUnavailable":
    "Saved profiles unavailable: {error}",
  "common.vehicle.notesAria": "Vehicle profile notes",
  "common.vehicle.optionMissing": "{name} · {type} (missing {fields})",
  "common.vehicle.phasesShort": "{count} ph",
  "common.vehicle.curve": "curve",
  "common.vehicle.noCurve": "no curve",
  "common.vehicle.profileGone": "This vehicle profile no longer exists.",
  "common.vehicle.unusableMissing":
    "{name} cannot be used for {type}: {fields} missing. Fill it in under Settings → Vehicle profiles.",
  "common.vehicle.unusableCurve":
    "{name} has a DC curve the simulator cannot use: {detail}.",
  "common.vehicle.warn.powerAboveDcMax":
    "The curve peaks at {peakKw} kW, above the declared DC maximum of {dcMaxKw} kW: the maximum is set to {peakKw} kW so no point of the curve is lost.",
  "common.vehicle.warn.curveCapped":
    "The curve peaks at {peakKw} kW, above the {dcMaxKw} kW DC maximum you set: it is held at {dcMaxKw} kW.",
  "common.vehicle.warn.curveStartsAboveZero":
    "The curve starts at {soc} % SoC: below that, its first power is held.",
  "common.vehicle.warn.curveEndsBelowFull":
    "The curve ends at {soc} % SoC: above that, its last power is held.",
  "common.vehicle.warn.noDcCurve":
    "No DC curve: the vehicle charges flat at its maximum power.",
  "common.vehicle.warn.unsupportedAcPhases":
    "The source gives {phases} AC phases; the simulator models 1 or 3, so a single phase is used.",
  "common.vehicle.warn.acPhasesUnknown":
    "The source gives no AC phase count: single phase is assumed.",
  "common.vehicle.storeUnsupported":
    "This console cannot store vehicle profiles",
  "common.log.filterValues": "Filter values",
  "common.log.filterGroupValues": "Filter {title} values",
  "common.log.none": "(none)",
  "common.log.sent": "Sent",
  "common.log.received": "Received",
  "common.log.sentArrow": "→ Sent",
  "common.log.receivedArrow": "← Received",
  "common.log.chargePointZero": "0 (charge point)",
  "common.log.connectorN": "Connector {id}",
  "common.log.filters": "Filters",
  "common.log.chargePoint": "Charge point",
  "common.log.level": "Level",
  "common.log.type": "Type",
  "common.log.connector": "Connector",
  "common.log.direction": "Direction",
  "common.log.action": "Action",
  "common.log.noChargePoints": "No charge points yet",
  "common.log.noConnectors": "No connector references yet",
  "common.log.noActions": "No OCPP actions parsed yet",
  "common.log.filtersToggleTitle": "Show or hide the filters",
  "common.log.logs": "Logs",
  "common.log.counts": "{total} total / {filtered} filtered",
  "common.log.autoScroll": "Auto-scroll",
  "common.log.download": "Download",
  "common.log.downloadTitle":
    "Download every persisted log row as a JSON Lines file.",
  "common.log.clearScreen": "Clear screen",
  "common.log.clearScreenTitle":
    "Hide the currently-displayed log lines. Persisted history stays.",
  "common.log.clearAll": "Clear screen + DB",
  "common.log.clearAllTitle":
    "Hide the displayed lines AND delete the persisted log rows.",
  "common.log.search": "Search in messages...",
  "common.log.details": "Details",
  "common.log.timestamp": "Timestamp",
  "common.log.message": "Message",
  "common.log.noLogs": "No logs yet",
  "common.log.noMatch": "No logs match the current filters",
  "common.log.hideDetails": "Hide details",
  "common.log.showDetails": "Show details",
  "common.time.never": "never",
  "common.time.justNow": "just now",
  "common.time.secondsAgo": "{count}s ago",
  "common.time.minutesAgo": "{count}m ago",
  "common.time.hoursAgo": "{count}h ago",
  "common.time.daysAgo": "{count}d ago",
  "common.catalog.unauthorizedLocal":
    "Open EV Directory refused the API key: it is missing, invalid, expired or revoked. Enter your personal key.",
  "common.catalog.unauthorizedRemote":
    "Open EV Directory refused the daemon's API key: it is missing, invalid, expired or revoked. Set OED_API_KEY on the daemon.",
  "common.catalog.rateLimitedIn":
    "Open EV Directory's rate limit is reached; try again in {seconds} s.",
  "common.catalog.rateLimited":
    "Open EV Directory's rate limit is reached; try again later.",
  "common.catalog.networkLocal":
    "Open EV Directory could not be reached. You may be offline, or the API does not allow calls from this page (CORS): import through the daemon instead (start it with --oed-base-url and OED_API_KEY).",
  "common.catalog.networkRemote":
    "Open EV Directory could not be reached: {message}",
  "common.catalog.timeout":
    "Open EV Directory did not answer in time; try again.",
  "common.catalog.notFound": "Not found in Open EV Directory: {message}",
  "common.catalog.notConfiguredLocal": "Enter the Open EV Directory URL first.",
  "common.catalog.notConfiguredRemote":
    "Vehicle import is turned off on the daemon (--oed-base-url none or OED_BASE_URL=none).",
  "common.payloadCondition": "payload condition",
} as const;
export default common;
