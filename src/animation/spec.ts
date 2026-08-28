export const IPE_EFFECTS = [
  "normal",
  "split-horizontal-in",
  "split-horizontal-out",
  "split-vertical-in",
  "split-vertical-out",
  "blinds-horizontal",
  "blinds-vertical",
  "box-in",
  "box-out",
  "wipe-left-right",
  "wipe-bottom-top",
  "wipe-right-left",
  "wipe-top-bottom",
  "dissolve",
  "glitter-left-right",
  "glitter-top-bottom",
  "glitter-diagonal",
  "fly-in-left-right",
  "fly-out-left-right",
  "fly-in-top-bottom",
  "fly-out-top-bottom",
  "push-left-right",
  "push-top-bottom",
  "cover-left-right",
  "cover-left-bottom",
  "uncover-left-right",
  "uncover-top-bottom",
  "fade",
] as const;
export type IpeEffect = (typeof IPE_EFFECTS)[number];
export const IPE_EFFECT_ID: Readonly<Record<IpeEffect, number>> = Object.freeze(
  Object.fromEntries(IPE_EFFECTS.map((name, id) => [name, id])) as Record<
    IpeEffect,
    number
  >,
);

export type AnimationViewer =
  | "ipe-presenter"
  | "acrobat"
  | "okular"
  | "evince"
  | "pdfpc"
  | "browser";
export type ViewerCapability = "verified" | "degraded" | "ignored" | "untested";
export interface ViewerProfile {
  readonly staticViews: ViewerCapability;
  readonly transitions: ViewerCapability;
  readonly notes: string;
}
export const VIEWER_MATRIX: Readonly<Record<AnimationViewer, ViewerProfile>> =
  Object.freeze({
    "ipe-presenter": {
      staticViews: "verified",
      transitions: "ignored",
      notes:
        "IpePresenter 7.2.30 navigates static views but does not interpret PDF transition effects.",
    },
    acrobat: {
      staticViews: "untested",
      transitions: "untested",
      notes: "No Acrobat version/platform was available for M7 verification.",
    },
    okular: {
      staticViews: "untested",
      transitions: "untested",
      notes:
        "Published conservatively until a pinned Okular runtime is exercised.",
    },
    evince: {
      staticViews: "untested",
      transitions: "untested",
      notes:
        "Published conservatively until a pinned Evince runtime is exercised.",
    },
    pdfpc: {
      staticViews: "untested",
      transitions: "untested",
      notes: "Presenter behavior was not exercised by the automated M7 lane.",
    },
    browser: {
      staticViews: "degraded",
      transitions: "ignored",
      notes:
        "Browsers expose PDF pages as static states; transition playback is not claimed.",
    },
  });

export interface AnimationDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly message: string;
}
export interface ExpansionLimits {
  readonly maxGeneratedViews?: number;
  readonly maxGeneratedCopies?: number;
  readonly maxPdfPages?: number;
}
export interface ExpansionEstimate {
  readonly generatedViews: number;
  readonly generatedCopies: number;
  readonly resultingPdfPages: number;
}
export interface AnimationResult {
  readonly viewIds: readonly string[];
  readonly layerIds: readonly string[];
  readonly objectIds: readonly string[];
  readonly estimate: ExpansionEstimate;
  readonly diagnostics: readonly AnimationDiagnostic[];
}
export type HandoutPolicy = "none" | "final" | "initial-and-final" | "all";
export type BboxPolicy =
  | { readonly kind: "fixed" }
  | { readonly kind: "per-view" }
  | { readonly kind: "explicit"; readonly box: AnimationBox };
export interface AnimationBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Pose {
  readonly x: number;
  readonly y: number;
}
export type SemanticEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";
