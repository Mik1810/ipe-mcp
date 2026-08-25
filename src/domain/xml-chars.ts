/** XML 1.0 (Fifth Edition) character production. */
export function isValidXml10String(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d &&
      !(codePoint >= 0x20 && codePoint <= 0xd7ff) &&
      !(codePoint >= 0xe000 && codePoint <= 0xfffd) &&
      !(codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      return false;
    }
  }
  return true;
}

export function assertValidXml10String(value: string): void {
  if (!isValidXml10String(value)) throw new Error("String contains an XML 1.0-invalid character");
}
