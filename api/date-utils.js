// api/date-utils.js

const SEASON_MAP = new Map([
  ["spring", { month: 3, length: 3 }],
  ["summer", { month: 6, length: 3 }],
  ["autumn", { month: 9, length: 3 }],
  ["fall", { month: 9, length: 3 }],
  ["winter", { month: 12, length: 3 }],
]);

const MONTH_MAP = new Map([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

function clampYear(year) {
  if (!year || Number.isNaN(year)) return null;
  if (year < 1200) return null;
  if (year > 2100) return null;
  return year;
}

function expandTwoDigitYear(raw) {
  if (raw.length !== 2) return null;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return null;
  const currentYear = new Date().getFullYear() % 100;
  const centuryBase = value <= currentYear + 5 ? 2000 : 1900;
  return clampYear(centuryBase + value);
}

function extractDateTokens(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tokens = trimmed.split(/\s+/);
  const dateTokens = [];
  let seenNumeric = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (
      /\d/.test(lower) ||
      lower.startsWith("c.") ||
      lower.startsWith("ca.") ||
      lower === "circa" ||
      lower === "c" ||
      SEASON_MAP.has(lower) ||
      MONTH_MAP.has(lower)
    ) {
      dateTokens.push(token);
      if (/\d/.test(lower)) seenNumeric = true;
      continue;
    }
    if (seenNumeric) break;
  }
  return dateTokens;
}

function buildRange(year, month = 1, day = 1, spanDays = 1) {
  if (!year) return null;
  const safeMonth = Math.min(Math.max(month, 1), 12);
  const safeDay = Math.min(Math.max(day, 1), 31);
  const start = Date.UTC(year, safeMonth - 1, safeDay);
  const end = Date.UTC(year, safeMonth - 1, safeDay + (spanDays - 1));
  return { start, end };
}

function rangeFromYear(year) {
  if (!year) return null;
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year, 11, 31, 23, 59, 59, 999);
  return { start, end };
}

function rangeFromMonth(year, month) {
  if (!year || !month) return null;
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

function rangeFromDecade(year) {
  if (!year) return null;
  const decadeStart = year - (year % 10);
  const start = Date.UTC(decadeStart, 0, 1);
  const end = Date.UTC(decadeStart + 9, 11, 31, 23, 59, 59, 999);
  return { start, end };
}

function normalizeSeason(year, seasonKey) {
  const info = SEASON_MAP.get(seasonKey);
  if (!info || !year) return null;
  const start = Date.UTC(year, info.month - 1, 1);
  const end = Date.UTC(year, info.month - 1 + (info.length - 1), 0, 23, 59, 59, 999);
  return { start, end };
}

function cleanDisplay(year, month, day) {
  if (year && month && day) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (year && month) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  }
  if (year) {
    return String(year);
  }
  return null;
}

function decadeDisplay(year) {
  if (!year) return null;
  const decadeStart = year - (year % 10);
  return `${decadeStart}s`;
}

export function parseFlexibleDate(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") raw = String(raw || "");
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidateTokens = extractDateTokens(trimmed);
  const candidate = candidateTokens.length ? candidateTokens.join(" ") : trimmed;
  const normalizedCandidate = candidate.replace(/[,\.]/g, " ").replace(/\s+/g, " ").trim();

  const isoDate = Date.parse(normalizedCandidate);
  if (!Number.isNaN(isoDate)) {
    const date = new Date(isoDate);
    const year = clampYear(date.getUTCFullYear());
    if (year) {
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      return {
        normalized: cleanDisplay(year, month, day),
        range: { start: Date.UTC(year, month - 1, day), end: Date.UTC(year, month - 1, day, 23, 59, 59, 999) },
        original: trimmed,
      };
    }
  }

  const dayMonthYear = normalizedCandidate.match(
    /^(\d{1,2})(?:st|nd|rd|th)?[\s/-]+([a-zA-Z]+)[\s/-]+(\d{2,4})$/
  );
  if (dayMonthYear) {
    const [, dStr, monthStr, yStr] = dayMonthYear;
    const month = MONTH_MAP.get(monthStr.toLowerCase());
    const year = clampYear(yStr.length === 2 ? expandTwoDigitYear(yStr) : Number.parseInt(yStr, 10));
    const day = Number.parseInt(dStr, 10);
    if (year && month && !Number.isNaN(day)) {
      const range = buildRange(year, month, day, 1);
      return {
        normalized: cleanDisplay(year, month, day),
        range,
        original: trimmed,
      };
    }
  }

  const monthDayYear = normalizedCandidate.match(
    /^([a-zA-Z]+)[\s/-]+(\d{1,2})(?:st|nd|rd|th)?[\s/-]+(\d{2,4})$/
  );
  if (monthDayYear) {
    const [, monthStr, dStr, yStr] = monthDayYear;
    const month = MONTH_MAP.get(monthStr.toLowerCase());
    const year = clampYear(yStr.length === 2 ? expandTwoDigitYear(yStr) : Number.parseInt(yStr, 10));
    const day = Number.parseInt(dStr, 10);
    if (year && month && !Number.isNaN(day)) {
      const range = buildRange(year, month, day, 1);
      return {
        normalized: cleanDisplay(year, month, day),
        range,
        original: trimmed,
      };
    }
  }

  const numericDmy = normalizedCandidate.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (numericDmy) {
    const [, dStr, mStr, yStr] = numericDmy;
    const day = Number.parseInt(dStr, 10);
    const month = Number.parseInt(mStr, 10);
    const year = clampYear(yStr.length === 2 ? expandTwoDigitYear(yStr) : Number.parseInt(yStr, 10));
    if (year && !Number.isNaN(month) && !Number.isNaN(day)) {
      const range = buildRange(year, month, day, 1);
      return {
        normalized: cleanDisplay(year, month, day),
        range,
        original: trimmed,
      };
    }
  }

  const numericYmd = normalizedCandidate.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (numericYmd) {
    const [, yStr, mStr, dStr] = numericYmd;
    const year = clampYear(Number.parseInt(yStr, 10));
    const month = Number.parseInt(mStr, 10);
    const day = Number.parseInt(dStr, 10);
    if (year && !Number.isNaN(month) && !Number.isNaN(day)) {
      const range = buildRange(year, month, day, 1);
      return {
        normalized: cleanDisplay(year, month, day),
        range,
        original: trimmed,
      };
    }
  }

  const monthYear = normalizedCandidate.match(/^([a-zA-Z]+)[\s-]+(\d{2,4})$/);
  if (monthYear) {
    const [, monthStr, yStr] = monthYear;
    const month = MONTH_MAP.get(monthStr.toLowerCase());
    const year = clampYear(yStr.length === 2 ? expandTwoDigitYear(yStr) : Number.parseInt(yStr, 10));
    if (year && month) {
      return {
        normalized: cleanDisplay(year, month),
        range: rangeFromMonth(year, month),
        original: trimmed,
      };
    }
  }

  const circaYear = normalizedCandidate.match(/^(?:c\.?|ca\.?|circa)\s*(\d{2,4})(?:s)?$/i);
  if (circaYear) {
    const [, yStr] = circaYear;
    const year = clampYear(yStr.length === 2 ? expandTwoDigitYear(yStr) : Number.parseInt(yStr, 10));
    if (year) {
      return {
        normalized: `circa ${year}`,
        range: rangeFromYear(year),
        original: trimmed,
      };
    }
  }

  const decade = normalizedCandidate.match(/^(\d{3})(\d)s$/);
  if (decade) {
    const [, prefix, digit] = decade;
    const year = clampYear(Number.parseInt(`${prefix}${digit}`, 10));
    if (year) {
      return {
        normalized: decadeDisplay(year),
        range: rangeFromDecade(year),
        original: trimmed,
      };
    }
  }

  const apostropheDecade = normalizedCandidate.match(/^'?([0-9]{2})s$/);
  if (apostropheDecade) {
    const [, twoDigit] = apostropheDecade;
    const expanded = expandTwoDigitYear(twoDigit);
    if (expanded) {
      return {
        normalized: decadeDisplay(expanded),
        range: rangeFromDecade(expanded),
        original: trimmed,
      };
    }
  }

  const plainYear = normalizedCandidate.match(/^(\d{4})$/);
  if (plainYear) {
    const year = clampYear(Number.parseInt(plainYear[1], 10));
    if (year) {
      return {
        normalized: String(year),
        range: rangeFromYear(year),
        original: trimmed,
      };
    }
  }

  const seasonYear = normalizedCandidate.match(/^(spring|summer|autumn|fall|winter)[\s-]+(\d{2,4})$/i);
  if (seasonYear) {
    const [, seasonRaw, yStr] = seasonYear;
    const season = seasonRaw.toLowerCase();
    const year = clampYear(yStr.length === 2 ? expandTwoDigitYear(yStr) : Number.parseInt(yStr, 10));
    if (year) {
      return {
        normalized: `${seasonRaw.charAt(0).toUpperCase()}${seasonRaw.slice(1).toLowerCase()} ${year}`,
        range: normalizeSeason(year, season),
        original: trimmed,
      };
    }
  }

  const yearWithSuffix = normalizedCandidate.match(/^(\d{4})[\s-]*(?:ad|ce)$/i);
  if (yearWithSuffix) {
    const year = clampYear(Number.parseInt(yearWithSuffix[1], 10));
    if (year) {
      return {
        normalized: String(year),
        range: rangeFromYear(year),
        original: trimmed,
      };
    }
  }

  return {
    normalized: trimmed,
    range: null,
    original: trimmed,
  };
}

export function normalizeDobInput(raw) {
  const parsed = parseFlexibleDate(raw);
  if (!parsed) return null;
  return parsed.normalized || parsed.original || null;
}

export function dobSortValue(raw) {
  const parsed = parseFlexibleDate(raw);
  if (!parsed?.range) return Number.POSITIVE_INFINITY;
  return parsed.range.start ?? Number.POSITIVE_INFINITY;
}

export function dobRange(raw) {
  const parsed = parseFlexibleDate(raw);
  if (!parsed?.range) return null;
  return parsed.range;
}
