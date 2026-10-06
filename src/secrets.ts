/**
 * Secret filter. Runs on every text before it is written to the local store.
 *
 * Deliberately pattern-based (no entropy guessing): commit SHAs, UUIDs and hashes are everywhere
 * in dev chats and must survive. A false negative here is a leak into a local file that never
 * leaves the machine; a false positive only costs a word in the digest.
 */

export interface RedactResult {
  text: string;
  /** How many secrets were replaced, per kind. Safe to log: no values. */
  found: Record<string, number>;
}

const mark = (kind: string) => `[REDACTED:${kind}]`;

// Not preceded by a letter/digit, so `task-…` or `disk-…` never look like `sk-…`.
const B = '(?<![A-Za-z0-9])';

interface Rule {
  kind: string;
  re: RegExp;
  /** Replacement; default replaces the whole match. */
  replace?: (m: string, ...groups: string[]) => string;
}

/** Placeholder values that are not secrets: types, env lookups, templates, masks. */
const PLACEHOLDER = new RegExp(
  '^(?:' +
    [
      'string', 'str', 'number', 'int', 'integer', 'bool', 'boolean', 'bytes', 'text', 'varchar(?:\\(\\d+\\))?',
      'secretstr', 'optional\\[.*', 'null', 'none', 'nil', 'undefined', 'true', 'false', 'required', 'optional',
      '\\*+', 'x{3,}', '\\.{3}', '…', '<[^>]*>', '\\{\\{.*\\}\\}', '\\$\\{.*\\}', '\\$[A-Za-z_][A-Za-z0-9_]*',
      '%\\(.*', '%s', 'process\\.env\\b.*', 'os\\.(?:environ|getenv)\\b.*', 'env\\(.*', 'getenv\\(.*',
      'config\\..*', 'settings\\..*', 'self\\..*', 'this\\..*', 'req\\..*', 'input\\(.*', 'args\\..*',
      '\\[REDACTED[^\\]]*\\]',
    ].join('|') +
    ')[,;]?$',
  'i',
);

/** Key names whose value is a secret: `password=…`, `"api_key": "…"`, `DB_PASSWORD=…`. */
const SECRET_KEY_NAME_PATTERN =
  '(?:[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|' +
  'auth[_-]?key|private[_-]?key|client[_-]?secret|credentials?)|(?:[A-Za-z0-9_.-]*[_.-])?pass)';

const RULES: Rule[] = [
  // PEM private keys, also an unterminated block (text cut in the middle of a key).
  {
    kind: 'private_key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: 'jwt', re: new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, 'g') },
  // Anthropic / OpenAI style: sk-ant-api03-…, sk-proj-…, sk-…
  { kind: 'api_key', re: new RegExp(`${B}sk-[A-Za-z0-9_-]{20,}`, 'g') },
  // Stripe and similar: sk_live_…, rk_test_…
  { kind: 'api_key', re: new RegExp(`${B}(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`, 'g') },
  { kind: 'github_token', re: new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})`, 'g') },
  { kind: 'gitlab_token', re: new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}`, 'g') },
  { kind: 'slack_token', re: new RegExp(`${B}(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}`, 'g') },
  { kind: 'aws_key', re: new RegExp(`${B}(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA|A3T[A-Z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])`, 'g') },
  { kind: 'google_key', re: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}`, 'g') },
  { kind: 'npm_token', re: new RegExp(`${B}npm_[A-Za-z0-9]{36}`, 'g') },
  { kind: 'sendgrid_key', re: new RegExp(`${B}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, 'g') },
  // Authorization headers: Bearer anywhere, Basic/Token only after "Authorization".
  {
    kind: 'bearer',
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_m, prefix) => `${prefix}${mark('bearer')}`,
  },
  {
    kind: 'auth_header',
    re: /\b(Authorization["']?\s*[:=]\s*["']?(?:Basic|Token|Digest)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, prefix) => `${prefix}${mark('auth_header')}`,
  },
  // Password in a URL: scheme://user:password@host
  {
    kind: 'url_password',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]+)(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${mark('url_password')}${at}`,
  },
];

/** `key = value`, `key: "value"`, `"key": "value"` where the key names a secret. */
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(${B}["']?${SECRET_KEY_NAME_PATTERN}["']?\\s*(?::|=|:=)\\s*)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'=][^\\s"',;]*))`,
  'gi',
);

/**
 * `Token: this is how it works` is prose, `password: qwerty` (YAML) is a secret. For an unquoted
 * value after a colon: a plain word followed by more text on the same line is prose.
 */
function looksLikeProse(value: string, whole: string, end: number): boolean {
  if (!/^[\p{L}]+$/u.test(value)) return false;
  const nl = whole.indexOf('\n', end);
  const rest = whole.slice(end, nl === -1 ? undefined : nl).trim();
  return rest !== '' && !rest.startsWith('#');
}

/** A line from a .env file: `KEY=value` or `export KEY=value`. */
const DOTENV_LINE_PATTERN = /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*=(.*)$/;

export function redactSecrets(input: string): RedactResult {
  const found: Record<string, number> = {};
  const hit = (kind: string) => {
    found[kind] = (found[kind] ?? 0) + 1;
  };
  let text = input;

  for (const rule of RULES) {
    text = text.replace(rule.re, (m: string, ...rest: unknown[]) => {
      hit(rule.kind);
      return rule.replace ? rule.replace(m, ...(rest.filter((x) => typeof x === 'string') as string[])) : mark(rule.kind);
    });
  }

  text = text.replace(SECRET_ASSIGNMENT_PATTERN, (m: string, prefix: string, dq: string | undefined, sq: string | undefined,
    bare: string | undefined, offset: number, whole: string) => {
    const value = dq ?? sq ?? bare ?? '';
    if (value === '' || PLACEHOLDER.test(value.trim()) || value.startsWith('[REDACTED')) return m;
    if (bare !== undefined && /:\s*$/.test(prefix) && looksLikeProse(bare, whole, offset + m.length)) return m;
    hit('password');
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `${prefix}${quote}${mark('password')}${quote}`;
  });

  text = redactEnvBlocks(text, hit);
  return { text, found };
}

/**
 * .env contents: two or more consecutive `KEY=value` lines are treated as an env file and every
 * value in the block is removed. A single `NODE_ENV=production` in prose is left alone; a single
 * secret-named line is already handled by SECRET_ASSIGNMENT_PATTERN.
 */
function redactEnvBlocks(text: string, hit: (kind: string) => void): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!DOTENV_LINE_PATTERN.test(lines[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && (DOTENV_LINE_PATTERN.test(lines[j]!) || /^[ \t]*#/.test(lines[j]!))) j++;
    const envLines = lines.slice(i, j).filter((l) => DOTENV_LINE_PATTERN.test(l)).length;
    if (envLines >= 2) {
      for (let k = i; k < j; k++) {
        const line = lines[k]!;
        const m = DOTENV_LINE_PATTERN.exec(line);
        if (!m) continue;
        const value = m[1]!.trim().replace(/^["']|["']$/g, '');
        if (value === '' || value.startsWith('[REDACTED') || PLACEHOLDER.test(value)) continue;
        lines[k] = line.slice(0, line.length - m[1]!.length) + mark('env');
        hit('env');
      }
    }
    i = Math.max(j, i + 1);
  }
  return lines.join('\n');
}

/** Merge per-kind counters (for a per-session total). */
export function addFound(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}
