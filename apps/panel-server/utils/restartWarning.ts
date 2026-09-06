export const RESTART_WARNING_SETTING_KEY = "restartWarning";
export const DEFAULT_RESTART_WARNING_LOCALE = "en";

type RestartWarningUnit = "minute" | "second";
type RestartWarningNotice = "cancelled" | "restarting";

interface RestartWarningPreset {
  template: string;
  units: Record<RestartWarningUnit, readonly [string, string]>;
  cancelled: string;
  restarting: string;
}

export interface RestartWarningSettings {
  locale: string;
  template: string;
}

interface RestartWarningInput {
  locale?: unknown;
  template?: unknown;
}

export const RESTART_WARNING_PRESETS: Readonly<
  Record<string, RestartWarningPreset>
> = Object.freeze({
  en: {
    template: "[SERVER] *** RESTART IN {count} {unit} ***",
    units: {
      minute: ["MINUTE", "MINUTES"],
      second: ["SECOND", "SECONDS"],
    },
    cancelled: "[SERVER] Restart CANCELLED.",
    restarting:
      "[SERVER] *** RESTARTING NOW - please reconnect in a few minutes ***",
  },
  "zh-CN": {
    template: "[服务器] *** 将在 {count}{unit} 后重启 ***",
    units: {
      minute: ["分钟", "分钟"],
      second: ["秒", "秒"],
    },
    cancelled: "[服务器] 重启已取消。",
    restarting: "[服务器] *** 正在重启，请在几分钟后重新连接 ***",
  },
  fr: {
    template: "[SERVEUR] *** REDÉMARRAGE DANS {count} {unit} ***",
    units: {
      minute: ["MINUTE", "MINUTES"],
      second: ["SECONDE", "SECONDES"],
    },
    cancelled: "[SERVEUR] Redémarrage ANNULÉ.",
    restarting:
      "[SERVEUR] *** REDÉMARRAGE EN COURS - reconnectez-vous dans quelques minutes ***",
  },
  de: {
    template: "[SERVER] *** NEUSTART IN {count} {unit} ***",
    units: {
      minute: ["MINUTE", "MINUTEN"],
      second: ["SEKUNDE", "SEKUNDEN"],
    },
    cancelled: "[SERVER] Neustart ABGEBROCHEN.",
    restarting:
      "[SERVER] *** NEUSTART LÄUFT - bitte in wenigen Minuten erneut verbinden ***",
  },
  es: {
    template: "[SERVIDOR] *** REINICIO EN {count} {unit} ***",
    units: {
      minute: ["MINUTO", "MINUTOS"],
      second: ["SEGUNDO", "SEGUNDOS"],
    },
    cancelled: "[SERVIDOR] Reinicio CANCELADO.",
    restarting:
      "[SERVIDOR] *** REINICIANDO - vuelve a conectarte en unos minutos ***",
  },
  ht: {
    template: "[SÈVÈ] *** REDÈMAJ NAN {count} {unit} ***",
    units: {
      minute: ["MINIT", "MINIT"],
      second: ["SEGOND", "SEGOND"],
    },
    cancelled: "[SÈVÈ] Redèmaj ANILE.",
    restarting:
      "[SÈVÈ] *** REDÈMAJ AN KOU - rekonekte nan kèk minit ***",
  },
});

function presetFor(locale: string): RestartWarningPreset {
  return (
    RESTART_WARNING_PRESETS[locale] ||
    RESTART_WARNING_PRESETS[DEFAULT_RESTART_WARNING_LOCALE]
  );
}

function normalizeTemplate(template: unknown): string | null {
  if (typeof template !== "string") return null;
  const normalized = template.trim();
  if (!normalized || normalized.length > 300) return null;
  if (/["\\]|[\x00-\x1F\x7F]/.test(normalized)) return null;
  if (/\p{So}|\p{Sk}|\p{Sm}|\p{Sc}|\u200D|\uFE0E|\uFE0F/gu.test(normalized)) {
    return null;
  }
  for (const token of normalized.match(/\{[^}]*\}/g) || []) {
    if (token !== "{count}" && token !== "{unit}") return null;
  }
  return normalized;
}

function inputFrom(value: unknown): RestartWarningInput {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RestartWarningInput)
    : {};
}

export function defaultRestartWarningSettings(
  locale = DEFAULT_RESTART_WARNING_LOCALE,
): RestartWarningSettings {
  const selectedLocale = RESTART_WARNING_PRESETS[locale]
    ? locale
    : DEFAULT_RESTART_WARNING_LOCALE;
  return {
    locale: selectedLocale,
    template: presetFor(selectedLocale).template,
  };
}

export function normalizeRestartWarningSettings(
  value: unknown,
): RestartWarningSettings {
  const input = inputFrom(value);
  const locale =
    typeof input.locale === "string" && RESTART_WARNING_PRESETS[input.locale]
      ? input.locale
      : DEFAULT_RESTART_WARNING_LOCALE;
  return {
    locale,
    template: normalizeTemplate(input.template) || presetFor(locale).template,
  };
}

export function validateRestartWarningSettings(
  value: unknown,
): RestartWarningSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Restart warning settings must be an object");
  }
  const input = value as RestartWarningInput;
  if (
    typeof input.locale !== "string" ||
    !RESTART_WARNING_PRESETS[input.locale]
  ) {
    throw new Error("Unsupported restart warning language");
  }
  const template = normalizeTemplate(input.template);
  if (!template) {
    throw new Error(
      "Restart warning must be 1-300 characters, use only {count}/{unit} placeholders, and contain no quotes, backslashes, controls, or emoji",
    );
  }
  return { locale: input.locale, template };
}

export function formatRestartWarning(
  settings: unknown,
  count: number | string,
  unitKind: RestartWarningUnit,
): string {
  const { locale, template } = normalizeRestartWarningSettings(settings);
  const units =
    presetFor(locale).units[unitKind] || presetFor(locale).units.minute;
  const unit = Number(count) === 1 ? units[0] : units[1];
  return template
    .replace(/\{count\}/g, String(count))
    .replace(/\{unit\}/g, unit);
}

export function getRestartWarningNotice(
  settings: unknown,
  notice: RestartWarningNotice,
): string {
  const { locale } = normalizeRestartWarningSettings(settings);
  return (
    presetFor(locale)[notice] ||
    presetFor(DEFAULT_RESTART_WARNING_LOCALE)[notice]
  );
}

export function getRestartWarningPresetTemplates(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(RESTART_WARNING_PRESETS).map(([locale, preset]) => [
      locale,
      preset.template,
    ]),
  );
}
