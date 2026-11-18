// A search for secrets in text (log lines, responses), for the whole-flow sweep (SEC-5.a, SEC-5.b).
//
// A plain substring search misses a secret that was written in another form, so each secret is
// searched for in the forms a careless log statement or error message would produce:
//   - as it is, and escaped for JSON (a quote or backslash in a password, also escaped twice
//     for JSON inside a JSON string), and as console.log prints it inside an object;
//   - percent-encoded (`%20`, in either letter case) and as a form body (`+` for a space);
//   - base64 and base64url, at all three byte alignments, so it is found inside a larger
//     base64 text such as the payload of a token; also the base64 of the JSON-escaped value
//     (a password with a quote, inside a JSON text that was then encoded);
//   - as hex, as the list of byte values a logged Buffer turns into (`49,50,51`), and as a
//     Buffer prints in the console (`<Buffer 62 72 61 …>`: lowercase hex bytes, spaced, the
//     first 50 bytes only, which is all the console shows).
// An HMAC (hex) is also searched as the base64, base64url and byte list of its raw bytes.
// A passcode is searched in its plain form only: not next to another digit (`otp012345` and
// `code=012345&` are hits, a longer number is not), and without its leading zeros as a JSON
// number value (`"code":12345`, what a passcode turned into a number prints as) when at least
// four digits are left. Before a passcode is searched, the text that is random by nature is
// blanked: uuids, hex runs of 32 characters or more and token-shaped text, and the
// `"name":number` pairs that legitimately hold numbers (balance, amount, time, iat, ...).
//
// False hits for a passcode, estimated: a given six-digit passcode appears by chance in a uuid
// (27 six-character windows of hex, each 1 in 16^6, and both neighbours must be non-digits) about
// 3 times in 10 million per uuid; with roughly 10 uuids and 7 passcodes in the flow, that is
// about 2 runs in 100,000 without the blanking, and none known with it. In a base64url token the
// chance per six-character window is 1 in 64^6 (about 1.5 in 100 billion): negligible, and the
// tokens are blanked anyway. Decimal digit runs inside the fixed `iat` and `exp` are numbers
// (digits on both sides), which are never a hit.
//
// What it does not look for: a secret that was hashed, encrypted, compressed, reversed, changed
// in case, cut into pieces or split across fields or lines, or only a part of it; a password
// hash re-encoded (its base64 parts as hex, say); an ENCODED passcode (six digits in base64,
// hex or bytes are short and the encodings of digits appear by chance inside the fixed `iat`
// and `exp` digits of every token, so a search for them is wrong about one run in 15,000).
// That space has no end; the realistic leak is a whole value written out by a log call or an
// error message.

import { inspect } from 'node:util';

export type SecretKind = 'passcode' | 'hmac' | 'other';

export type Secret = {
  /** Names the secret in a finding; never the value. */
  label: string;
  value: string;
  /**
   * `passcode`: six digits; its plain form only counts between characters that cannot continue
   * it (not a letter or digit): digits inside a timestamp, an id or a hash don't. `hmac`: a hex
   * digest, also searched as its raw bytes.
   */
  kind?: SecretKind;
};

export type Finding = { secret: string; form: string };

type Variant = { form: string; text: string; ignoreCase?: boolean };

/** A secret shorter than this would match by accident (the empty string matches everything). */
export const MIN_SECRET_LENGTH = 6;

/**
 * Numbers that legitimately sit in log lines and bodies, whatever they are. A six-digit
 * passcode can equal a balance (100000 to 1000000 agorot) by chance, so these `"name":number`
 * pairs are blanked before a passcode is searched for, or the sweep would fail one run in a
 * hundred thousand.
 */
const NUMERIC_FIELDS =
  /"(?:balance|amount|expiresIn|iat|exp|time|responseTime|statusCode|reqId|remotePort|port|pid)":-?\d+/g;

/** Random by nature, so a passcode found inside one is chance: a uuid, a long hex run, a token. */
const RANDOM_IDS =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32,}\b|eyJ[\w-]+\.[\w-]+\.[\w-]+/gi;

/** `text` without what a passcode's digits could only match by chance, once per text. */
const blanked = (text: string) => text.replace(RANDOM_IDS, ' ').replace(NUMERIC_FIELDS, ' ');

const jsonEscaped = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * `bytes` in base64 as it appears inside a longer base64 text. The value may start at any byte
 * offset in that text, so it is encoded behind 0, 1 and 2 padding bytes, and the characters that
 * also depend on a neighbouring byte are cut off at both ends.
 */
function base64Forms(bytes: Buffer): string[] {
  const forms: string[] = [];
  for (const padding of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(padding), bytes])
      .toString('base64')
      .replace(/=+$/, '');
    const start = [0, 2, 3][padding] ?? 0;
    const end = (padding + bytes.length) % 3 === 0 ? encoded.length : encoded.length - 1;
    forms.push(encoded.slice(start, end));
  }
  return forms;
}

const toBase64Url = (text: string) => text.replaceAll('+', '-').replaceAll('/', '_');

const utf8 = (text: string) => Buffer.from(text, 'utf8');
const byteList = (bytes: Buffer) => [...bytes].join(',');
/** What console.log shows of a Buffer: its first 50 bytes, as lowercase hex, spaced. */
const bufferPrint = (bytes: Buffer) =>
  [...bytes.subarray(0, 50)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** Every form of `value` the sweep looks for (the plain one first). */
export function variantsOf(value: string, kind: SecretKind = 'other'): Variant[] {
  if (kind === 'passcode') return [{ form: 'plain', text: value }];
  const percent = encodeURIComponent(value);
  const escaped = jsonEscaped(value);
  const bytes = utf8(value);
  const variants: Variant[] = [
    { form: 'plain', text: value, ignoreCase: kind === 'hmac' },
    { form: 'JSON-escaped', text: escaped },
    { form: 'JSON-escaped twice', text: jsonEscaped(escaped) },
    // What console.log prints for a string inside an object (quoted JavaScript, not JSON).
    { form: 'inspected', text: inspect(value).slice(1, -1) },
    { form: 'percent-encoded', text: percent },
    {
      form: 'percent-encoded, lowercase hex',
      text: percent.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    },
    { form: 'form-encoded', text: new URLSearchParams({ v: value }).toString().slice(2) },
    ...base64Forms(bytes).map((text) => ({ form: 'base64', text })),
    ...base64Forms(bytes).map((text) => ({ form: 'base64url', text: toBase64Url(text) })),
    { form: 'hex', text: bytes.toString('hex'), ignoreCase: true },
    { form: 'byte list', text: byteList(bytes) },
    { form: 'Buffer print', text: bufferPrint(bytes), ignoreCase: true },
  ];
  if (escaped !== value) {
    const forms = base64Forms(utf8(escaped));
    variants.push(
      ...forms.map((text) => ({ form: 'base64 of the JSON-escaped', text })),
      ...forms.map((text) => ({ form: 'base64url of the JSON-escaped', text: toBase64Url(text) })),
    );
  }
  if (kind === 'hmac') {
    const raw = Buffer.from(value, 'hex');
    const forms = base64Forms(raw);
    variants.push(
      ...forms.map((text) => ({ form: 'base64 of the raw bytes', text })),
      ...forms.map((text) => ({ form: 'base64url of the raw bytes', text: toBase64Url(text) })),
      { form: 'byte list of the raw bytes', text: byteList(raw) },
      { form: 'Buffer print of the raw bytes', text: bufferPrint(raw), ignoreCase: true },
    );
  }
  const seen = new Set<string>();
  return variants.filter(({ text }) => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The plain form of a passcode: not next to another digit. */
const standalone = (passcode: string) => new RegExp(`(?<![0-9])${escapeRegExp(passcode)}(?![0-9])`);

/** A passcode without its leading zeros, as a JSON number value (after `:`, `[` or `,`). */
const asJsonNumber = (digits: string) =>
  new RegExp(`(?<=[:\\[,]\\s*)${digits}(?=\\s*[,}\\]]|\\s*$)`);

/** The shortest number worth searching for: fewer digits would be a number of any other kind. */
const MIN_NUMBER_DIGITS = 4;

/** The forms in which a passcode is in `cleaned` (the text with the random parts blanked). */
function passcodeForms(code: string, cleaned: string): string[] {
  const forms: string[] = [];
  if (standalone(code).test(cleaned)) forms.push('plain');
  const bare = code.replace(/^0+/, '');
  if (bare !== code && bare.length >= MIN_NUMBER_DIGITS && asJsonNumber(bare).test(cleaned)) {
    forms.push('number without its leading zeros');
  }
  return forms;
}

/** A secret's variants, built once: the same secrets are searched in every text of a run. */
const variantCache = new Map<string, (Variant & { lower: string })[]>();
function variantsFor(secret: Secret) {
  const key = `${secret.kind ?? 'other'}\0${secret.value}`;
  let variants = variantCache.get(key);
  if (!variants) {
    variants = variantsOf(secret.value, secret.kind).map((v) => ({
      ...v,
      lower: v.text.toLowerCase(),
    }));
    variantCache.set(key, variants);
  }
  return variants;
}

/** Every secret that appears in `text`, in any covered form. */
export function findSecrets(text: string, secrets: readonly Secret[]): Finding[] {
  const found: Finding[] = [];
  const lowered = text.toLowerCase();
  let cleaned: string | undefined;
  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_LENGTH) {
      throw new Error(`the sweep's secret "${secret.label}" is too short to be searched for`);
    }
    if (secret.kind === 'passcode') {
      cleaned ??= blanked(text);
      for (const form of passcodeForms(secret.value, cleaned)) {
        found.push({ secret: secret.label, form });
      }
      continue;
    }
    for (const { form, text: needle, lower, ignoreCase } of variantsFor(secret)) {
      if (ignoreCase ? lowered.includes(lower) : text.includes(needle)) {
        found.push({ secret: secret.label, form });
      }
    }
  }
  return found;
}

/** `where` and what was found there, with each secret named by its label only. */
export function sweep(
  texts: readonly { where: string; text: string }[],
  secrets: readonly Secret[],
) {
  return texts.flatMap(({ where, text }) =>
    findSecrets(text, secrets).map((finding) => ({ where, ...finding })),
  );
}

/**
 * Anything shaped like a signed token (`header.payload.signature`, the header being base64url of
 * `{"`), whoever issued it: a token the sweep has never seen is found too.
 */
export const jwtsIn = (text: string): string[] => text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? [];
