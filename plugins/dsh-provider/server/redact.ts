const TOKEN = /([?&]token=)[^&\s]+/gi;
const URL = /https?:\/\/[^\s]+/gi;

/** Remove launch tokens and login links before any error or diagnostic is stored. */
export function redact(value: string): string {
  return value.replace(TOKEN, "$1redacted").replace(URL, "[url]");
}
