export type NativeErrorCode =
  | "NATIVE_UNAVAILABLE"
  | "NATIVE_TIMEOUT"
  | "NATIVE_CRASH"
  | "NATIVE_OUTPUT_LIMIT"
  | "NATIVE_RESOURCE_LIMIT"
  | "NATIVE_LOAD_ERROR"
  | "NATIVE_STYLE_ERROR"
  | "NATIVE_TEX_ERROR"
  | "NATIVE_RENDER_ERROR"
  | "NATIVE_EXPORT_ERROR";

export class NativeIpeError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message: string,
    readonly diagnostics: readonly string[] = [],
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "NativeIpeError";
  }
}
