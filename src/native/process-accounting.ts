export const NATIVE_SUBPROCESS_COUNTS = {
  capabilities: 24,
  reload: 2,
  checkStyle: 1,
  runLatex: 2,
  exportPdf(states: number): number { return 5 + 3 * states; },
  renderViews(states: number): number { return 4 * states; },
  validateFull(states: number): number { return 34 + 7 * states; },
} as const;
