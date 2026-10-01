import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/secrets.js';

// Fake credentials are assembled at runtime so the test file itself never trips a secret scanner.
const j = (...parts: string[]) => parts.join('');
const A36 = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5';
const FAKE = {
  anthropic: j('sk-', 'ant-api03-', 'Xy7Qp2Lm9Kd4Rt6Wv8Za1Bc3De5Fg7Hj9Km2Np4Qr6St8-_AAAA'),
  openai: j('sk-', 'proj-', 'q8W2e4R6t8Y0u2I4o6P8a0S2d4F6g8H0'),
  stripe: j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  ghp: j('gh', 'p_', A36),
  ghs: j('gh', 's_', A36),
  ghPat: j('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'),
  glpat: j('gl', 'pat-', 'xYz12345abcdeFGHIJ678'),
  slackBot: j('xo', 'xb-', '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  slackUser: j('xo', 'xp-', '1234567890-1234567890-1234567890-abcdef0123456789'),
  aws: j('AK', 'IA', 'IOSFODNN7', 'EXAMPLE'),
  awsSecret: j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'),
  google: j('AI', 'za', 'SyA-1234567890abcdefghijklmnopqrstu'),
  npm: j('np', 'm_', A36),
  sendgrid: j('SG', '.aB3dE5fG7hJ9kL1mN3pQ5r', '.', 'S7tU9vW1xY3zA5bC7dE9fG1hJ3kL5mN7pQ9rS1tU3v_-'),
  jwt: j('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  bearer: j('abc123', 'DEF456', 'ghi789', 'JKL'),
};

const PEM = [
  j('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  'MIIEowIBAAKCAQEA7x5gkq1YQ0rX3yJk2m9bVb2i0pQ9H9aZ8n0M7yT6uV5wX4',
  'q1YQ0rX3yJk2m9bVb2i0pQ9H9aZ8n0M7yT6uV5wX4yZ3a2b1c0d9e8f7g6h5i4',
  j('-----END ', 'RSA PRIVATE KEY-----'),
].join('\n');

const clean = (s: string) => redactSecrets(s).text;
const kinds = (s: string) => redactSecrets(s).found;

describe('redactSecrets: tokens and keys', () => {
  it.each([
    ['anthropic key', FAKE.anthropic, 'api_key'],
    ['openai project key', FAKE.openai, 'api_key'],
    ['stripe live key', FAKE.stripe, 'api_key'],
    ['github classic token', FAKE.ghp, 'github_token'],
    ['github app token', FAKE.ghs, 'github_token'],
    ['github fine-grained token', FAKE.ghPat, 'github_token'],
    ['gitlab token', FAKE.glpat, 'gitlab_token'],
    ['slack bot token', FAKE.slackBot, 'slack_token'],
    ['slack user token', FAKE.slackUser, 'slack_token'],
    ['aws access key id', FAKE.aws, 'aws_key'],
    ['google api key', FAKE.google, 'google_key'],
    ['npm token', FAKE.npm, 'npm_token'],
    ['sendgrid key', FAKE.sendgrid, 'sendgrid_key'],
    ['jwt', FAKE.jwt, 'jwt'],
  ])('%s', (_name, secret, kind) => {
    const out = redactSecrets(`here it is: ${secret} — use it`);
    expect(out.text).not.toContain(secret);
    expect(out.text).toBe(`here it is: [REDACTED:${kind}] — use it`);
    expect(out.found[kind]).toBe(1);
  });

  it('keeps surrounding punctuation and quotes', () => {
    expect(clean(`const key = "${FAKE.ghp}";`)).toBe('const key = "[REDACTED:github_token]";');
    expect(clean(`(${FAKE.aws})`)).toBe('([REDACTED:aws_key])');
  });

  it('redacts several secrets in one text', () => {
    const out = redactSecrets(`a ${FAKE.ghp} b ${FAKE.slackBot} c ${FAKE.anthropic}`);
    expect(out.found).toEqual({ github_token: 1, slack_token: 1, api_key: 1 });
  });

  it('redacts a PEM private key block', () => {
    const out = redactSecrets(`key:\n${PEM}\nthanks`);
    expect(out.text).toBe('key:\n[REDACTED:private_key]\nthanks');
  });

  it('redacts an OpenSSH / EC / PKCS8 private key', () => {
    for (const label of ['OPENSSH PRIVATE KEY', 'EC PRIVATE KEY', 'PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      const block = `${j('-----BEGIN ', label, '-----')}\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ\n${j('-----END ', label, '-----')}`;
      expect(clean(block)).toBe('[REDACTED:private_key]');
    }
  });

  it('redacts a private key cut off before its END line', () => {
    const cut = PEM.split('\n').slice(0, 2).join('\n');
    expect(clean(`see ${cut}`)).toBe('see [REDACTED:private_key]');
  });

  it('keeps a public key and a certificate', () => {
    const pub = `${j('-----BEGIN ', 'PUBLIC KEY-----')}\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n${j('-----END ', 'PUBLIC KEY-----')}`;
    expect(clean(pub)).toBe(pub);
    expect(clean('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl dev@laptop')).toContain(
      'ssh-ed25519 AAAAC3',
    );
  });
});

describe('redactSecrets: headers and URLs', () => {
  it('redacts a Bearer token but keeps the word', () => {
    expect(clean(`curl -H "Authorization: Bearer ${FAKE.bearer}" https://api.x`)).toBe(
      'curl -H "Authorization: Bearer [REDACTED:bearer]" https://api.x',
    );
  });

  it('redacts Basic auth after Authorization', () => {
    expect(clean('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [REDACTED:auth_header]');
  });

  it('redacts the password in a URL, keeps user and host', () => {
    expect(clean('DATABASE_URL is postgres://app:s3cr3t-P4ss@db.internal:5432/billing')).toBe(
      'DATABASE_URL is postgres://app:[REDACTED:url_password]@db.internal:5432/billing',
    );
    expect(clean('git clone https://oauth2:tok3n@gitlab.example.com/acme/api.git')).toBe(
      'git clone https://oauth2:[REDACTED:url_password]@gitlab.example.com/acme/api.git',
    );
  });
});

describe('redactSecrets: key=value', () => {
  it.each([
    ['password=hunter2', 'password=[REDACTED:password]'],
    ['password = qwerty', 'password = [REDACTED:password]'],
    ['DB_PASSWORD=p@ss', 'DB_PASSWORD=[REDACTED:password]'],
    ['DB_PASS=letmein', 'DB_PASS=[REDACTED:password]'],
    ['"password": "hunter2"', '"password": "[REDACTED:password]"'],
    ["api_key: 'abc123xyz'", "api_key: '[REDACTED:password]'"],
    ['client_secret=Zm9vYmFy', 'client_secret=[REDACTED:password]'],
    ['GITHUB_TOKEN=abc', 'GITHUB_TOKEN=[REDACTED:password]'],
    ['password: qwerty', 'password: [REDACTED:password]'],
    ['  password: qwerty  # prod', '  password: [REDACTED:password]  # prod'],
    ['token := "abc"', 'token := "[REDACTED:password]"'],
    ['mysql -u root --password=r00t!', 'mysql -u root --password=[REDACTED:password]'],
  ])('%s', (input, expected) => {
    expect(clean(input)).toBe(expected);
  });

  it('does not count an already redacted value twice', () => {
    const out = redactSecrets(`GITHUB_TOKEN=${FAKE.ghp}`);
    expect(out.text).toBe('GITHUB_TOKEN=[REDACTED:github_token]');
    expect(out.found).toEqual({ github_token: 1 });
  });
});

describe('redactSecrets: .env contents', () => {
  it('redacts every value of an env block', () => {
    const env = [
      '# prod',
      'DATABASE_HOST=db.internal',
      'AWS_SECRET_ACCESS_KEY=' + FAKE.awsSecret,
      'export STRIPE_WEBHOOK=whsec_abc',
      'EMPTY=',
    ].join('\n');
    const out = clean(env);
    expect(out).toBe(
      ['# prod', 'DATABASE_HOST=[REDACTED:env]', 'AWS_SECRET_ACCESS_KEY=[REDACTED:password]', 'export STRIPE_WEBHOOK=[REDACTED:env]', 'EMPTY='].join('\n'),
    );
    expect(out).not.toContain(FAKE.awsSecret);
  });

  it('leaves a single innocent env assignment in prose', () => {
    expect(clean('run it with NODE_ENV=production please')).toBe('run it with NODE_ENV=production please');
    expect(clean('NODE_ENV=production\n\nthen restart')).toBe('NODE_ENV=production\n\nthen restart');
  });
});

describe('redactSecrets: false positives stay untouched', () => {
  it.each([
    ['commit sha', 'fixed in 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39'],
    ['uuid', 'session 55397f84-3193-4c52-a7ce-0ebd8f1be03a ended'],
    ['ticket ids', 'PAY-42 and CORE-1337 are done'],
    ['words ending in sk', 'the task-queue and disk-usage-monitoring-service-v2 are fine'],
    ['scikit', 'use sk-learn for that'],
    ['token counts', 'max_tokens=4096, input_tokens: 2, token_count = 17'],
    ['type annotations', 'password: string;\n  token?: string | null;\n  apiKey: string'],
    ['python types', 'password: str = Field(...)\nsecret: SecretStr'],
    ['env lookups', 'password = os.getenv("DB_PASSWORD")\nconst token = process.env.GITHUB_TOKEN;'],
    ['templates', 'password: ${DB_PASSWORD}\ntoken = "{{ vault_token }}"\napi_key: <your-key>'],
    ['masked', 'password: ********'],
    ['prose after colon', 'Token: this is how the refresh flow works'],
    ['url without password', 'see https://user@github.com/acme/api and http://localhost:3000/health'],
    ['git ssh remote', 'git@github.com:acme/billing-api.git'],
    ['comparison', 'if password == confirm then ok'],
    ['bearer word in prose', 'the bearer of this message'],
    ['short Bearer placeholder', 'Authorization: Bearer <token>'],
    ['base64 in code', 'const icon = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="'],
    ['aws-ish but lowercase', 'akiaiosfodnn7example is not a key'],
    ['russian prose', 'Пароль хранится в vault, токен выдаёт SSO'],
    ['bypass flag', 'bypass=true, compass: north'],
  ])('%s', (_name, input) => {
    const out = redactSecrets(input);
    expect(out.text).toBe(input);
    expect(out.found).toEqual({});
  });

  it('reports nothing for empty text', () => {
    expect(kinds('')).toEqual({});
  });
});
