export type PublicTextCredentialCategory =
  | "configured_provider_key"
  | "private_key"
  | "authorization_header"
  | "credential_field";

const PLACEHOLDER = /^(?:\*{3}|<redacted>|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY-----/i;
const AUTHORIZATION_LINE =
  /^[\t ]*authorization[\t ]*:[\t ]*(?:basic|bearer)[\t ]+([^\r\n]+?)[\t ]*$/gim;
const CREDENTIAL_FIELD =
  /(?:^|[\s{[,;])["']?(?:api-key|api_key|apikey|token|secret|password)["']?[\t ]*(?::|=)[\t ]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s,;}\]\r\n]+))/gim;

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2
    && ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return PLACEHOLDER.test(unquoted);
}

export function classifyPublicText(
  text: string,
  configuredKeys: readonly string[],
): PublicTextCredentialCategory | null {
  if (configuredKeys.some((key) => key.length > 0 && text.includes(key))) {
    return "configured_provider_key";
  }
  if (PRIVATE_KEY_BLOCK.test(text)) return "private_key";
  AUTHORIZATION_LINE.lastIndex = 0;
  for (const match of text.matchAll(AUTHORIZATION_LINE)) {
    const value = match[1].trim();
    if (value && !isPlaceholder(value)) return "authorization_header";
  }
  CREDENTIAL_FIELD.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_FIELD)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value && !isPlaceholder(value)) return "credential_field";
  }
  return null;
}
