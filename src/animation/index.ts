export {
  IPE_EFFECTS,
  IPE_EFFECT_ID,
  VIEWER_MATRIX,
} from "./spec.js";
export type {
  IpeEffect,
  AnimationViewer,
  ViewerCapability,
  ViewerProfile,
  AnimationDiagnostic,
  ExpansionLimits,
  ExpansionEstimate,
  AnimationResult,
  HandoutPolicy,
  BboxPolicy,
  AnimationBox,
  Pose,
  SemanticEasing,
} from "./spec.js";
export { estimateAnimationExpansion } from "./state.js";
export { buildReveal } from "./reveal.js";
export type { RevealTarget, RevealOptions } from "./reveal.js";
export { buildMotion, buildPanelScroll, buildCameraPan } from "./motion.js";
export type {
  MotionOptions,
  PanelScrollOptions,
  CameraPanOptions,
} from "./motion.js";
export { setTransition } from "./transition.js";
export type { TransitionOptions } from "./transition.js";
