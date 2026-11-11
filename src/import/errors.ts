export interface ImportDiagnostic {
  readonly code: string;
  readonly location: string;
}

export class VectorImportError extends Error {
  readonly code = "VECTOR_IMPORT_REJECTED";
  constructor(readonly diagnostic: ImportDiagnostic) {
    super("Vector import rejected");
    this.name = "VectorImportError";
  }
}

export function rejectImport(code: string, location: string): never {
  throw new VectorImportError({ code, location });
}
