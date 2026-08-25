export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "RevisionConflictError";
  }
}

export class SourceChangedError extends Error {
  readonly code = "SOURCE_CHANGED";

  constructor(readonly path: string) {
    super(`source changed outside the session: ${path}`);
    this.name = "SourceChangedError";
  }
}

export class PathOutsideWorkspaceError extends Error {
  readonly code = "PATH_OUTSIDE_WORKSPACE";

  constructor(readonly path: string) {
    super(`path is outside the configured workspace roots: ${path}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

export class StructuralValidationError extends Error {
  readonly code = "STRUCTURAL_VALIDATION_FAILED";

  constructor(readonly diagnostics: readonly SessionDiagnostic[]) {
    super("document mutation failed structural validation");
    this.name = "StructuralValidationError";
  }
}

export interface SessionDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
