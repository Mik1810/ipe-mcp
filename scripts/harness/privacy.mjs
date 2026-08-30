const secretPatterns = [
  /Bearer\s+[^\s,;]+/giu,
  /(?:password|token|secret|_authToken)\s*[=:]\s*[^\s,;]+/giu,
  /(?:npm|gh[pousr])_[A-Za-z0-9_\-]{20,}/gu,
];

const pathPatterns = [
  /(?:[A-Za-z]:[\\/]|(?<![\w:/])\/)(?:[^\s"'<>]| (?=[^\r\n]))+/gu,
];

export function redactPortableText(value, maximum = 400) {
  let text = String(value ?? "");
  for (const pattern of secretPatterns) text = text.replace(pattern, "<redacted-secret>");
  for (const pattern of pathPatterns) text = text.replace(pattern, "<redacted-path>");
  return text.slice(0, maximum);
}

export function assertPortableValue(value) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    /(?:[A-Za-z]:[\\/]|(?<![\w:/])\/)\S+/u,
    /Bearer\s+/iu,
    /(?:password|token|secret|_authToken)\s*[=:]/iu,
    /(?:npm|gh[pousr])_[A-Za-z0-9_\-]{20,}/u,
    /(?:chain[-_ ]of[-_ ]thought|private[-_ ]reasoning|reasoning_content)/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new HarnessFailure("harness", "NON_PORTABLE_RESULT", "Portable result contains a forbidden field or value");
  }
}

export class HarnessFailure extends Error {
  constructor(stage, code, message) {
    super(redactPortableText(message));
    this.name = "HarnessFailure";
    this.stage = stage;
    this.code = code;
  }
}

export function portableFailure(error, fallbackStage = "harness", fallbackCode = "HARNESS_ERROR") {
  if (error instanceof HarnessFailure) {
    return { stage: error.stage, code: error.code, message: redactPortableText(error.message) };
  }
  return { stage: fallbackStage, code: fallbackCode, message: redactPortableText(error?.message ?? error) || "Unknown harness error" };
}
