import { z } from "zod";

import { MCP_LIMITS, MODEL_TEXT_CAPS } from "../limits.js";

export const MCP_CONTRACT_VERSION = "ipe-mcp/1" as const;
export const MAX_HINTS = MCP_LIMITS.maxHints;

const maxCode = MODEL_TEXT_CAPS.hintCode;
const maxMessage = MODEL_TEXT_CAPS.hintMessage;
const maxSummary = MODEL_TEXT_CAPS.summary;
const maxName = MODEL_TEXT_CAPS.name;
const maxTitle = MODEL_TEXT_CAPS.title;
const maxNotes = MODEL_TEXT_CAPS.notes;
const maxStyle = MODEL_TEXT_CAPS.styleText;
const maxDash = MODEL_TEXT_CAPS.dashPattern;
const maxPath = MODEL_TEXT_CAPS.url;
const maxIds = MCP_LIMITS.idListMax;

export const documentIdSchema = z.string().uuid().describe("Document session ID returned by create/open; never guess it.");
export const revisionSchema = z.number().int().nonnegative().describe("Exact current revision returned by the previous mutation; stale values are rejected without writes.");
export const entityIdSchema = z.string().regex(/^(page|layer|view|object|style|asset)-[0-9a-f]{24}$/u).describe("Exact persistent entity ID returned by inspect or a mutation result; do not derive it from names or indexes.");

export const hintSchema = z.object({
  priority: z.enum(["warning", "recovery", "nudge"]).describe("How urgently the model should act on this hint."),
  code: z.string().min(1).max(maxCode).describe("Stable machine-readable hint code."),
  message: z.string().min(1).max(maxMessage).describe("Sanitized corrective guidance."),
}).strict().describe("One bounded model-facing recovery or workflow hint.");

export const publicErrorSchema = z.object({
  code: z.string().min(1).max(maxCode).describe("Stable discriminant such as REVISION_CONFLICT or INVALID_ARGUMENT."),
  message: z.string().min(1).max(maxMessage).describe("Safe explanation without sensitive paths or document content."),
  retryable: z.boolean().describe("Whether retrying after the stated correction can succeed."),
  correction: z.string().min(1).max(maxMessage).describe("Concrete next action for recovery."),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Minimal structural metadata; never free text, paths, or content."),
}).strict().describe("Versioned actionable public failure details.");

export const resultSchema = z.object({
  contractVersion: z.literal(MCP_CONTRACT_VERSION).describe("Public result contract version."),
  ok: z.boolean().describe("True only when the requested tool operation completed."),
  kind: z.string().min(1).max(maxCode).describe("Stable tool-result kind."),
  summary: z.string().min(1).max(maxSummary).describe("Short sanitized outcome suitable for model context."),
  data: z.record(z.string(), z.json()).describe("Bounded JSON-only public data; tool-specific meaning is described by kind and the tool contract."),
  hints: z.array(hintSchema).max(MAX_HINTS).describe("At most three prioritized recovery or workflow hints."),
  error: publicErrorSchema.optional().describe("Present only when ok is false."),
}).strict().describe("Stable ipe-mcp/1 tool result envelope.");

export type PublicResult = z.infer<typeof resultSchema>;

const finite = (description: string) => z.number().finite().describe(description);
const positive = (description: string) => z.number().positive().finite().describe(description);
const point = z.object({ x: finite("Ipe x coordinate in bp."), y: finite("Ipe y coordinate in bp.") }).strict().describe("Point in Ipe page coordinates, measured in bp.");
const box = z.object({ x: finite("Left x coordinate in bp."), y: finite("Bottom y coordinate in bp."), width: positive("Box width in bp."), height: positive("Box height in bp.") }).strict().describe("Finite positive rectangle in Ipe page coordinates.");
const matrix = z.tuple([finite("Matrix a."), finite("Matrix b."), finite("Matrix c."), finite("Matrix d."), finite("Matrix e translation."), finite("Matrix f translation.")]).describe("Ipe affine matrix [a,b,c,d,e,f].");
const position = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["back", "front"]).describe("Absolute placement in the page-global z-order.") }).strict(),
  z.object({ kind: z.enum(["before", "after"]).describe("Placement relative to an existing object."), objectId: entityIdSchema.describe("Reference object on the same page.") }).strict(),
]).describe("Global z-order insertion or move position; layers do not partition z-order.");
const pagePatch = z.object({
  name: z.string().min(1).max(maxName).optional().describe("Unique PDF destination name; omitted leaves it unchanged."),
  title: z.string().max(maxTitle).optional().describe("Visible page title metadata; omitted leaves it unchanged."),
  section: z.string().max(maxTitle).optional().describe("Page section metadata; omitted leaves it unchanged."),
  subsection: z.string().max(maxTitle).optional().describe("Page subsection metadata; omitted leaves it unchanged."),
  notes: z.string().max(maxNotes).optional().describe("Presenter notes shared by the page views; omitted leaves them unchanged."),
  marked: z.boolean().optional().describe("Whether the page is marked for handout-oriented workflows."),
}).strict().describe("Semantic page fields to update atomically.");

const pathStyle = z.object({
  stroke: z.string().max(maxStyle).optional().describe("Numeric color or defined Ipe color style name."),
  fill: z.string().max(maxStyle).optional().describe("Numeric color or defined Ipe color style name; omit for no fill."),
  pen: z.union([z.string().max(maxStyle), positive("Numeric pen width in bp.")]).optional().describe("Positive pen width or defined Ipe pen style."),
  dash: z.string().max(maxDash).optional().describe("Defined dash style or valid Ipe/PDF dash pattern."),
  opacity: z.string().max(maxStyle).optional().describe("Defined Ipe opacity style."),
}).strict().describe("Supported paint attributes for a compiled path.");
const styled = { style: pathStyle.optional().describe("Optional path paint style.") };
export const pathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point").describe("Single point path."), point, ...styled }).strict(),
  z.object({ kind: z.literal("segment").describe("Straight line segment."), from: point.describe("Segment start."), to: point.describe("Segment end."), ...styled }).strict(),
  z.object({ kind: z.enum(["polyline", "polygon"]).describe("Open polyline or closed polygon."), points: z.array(point).min(2).max(MCP_LIMITS.pathPointsMax).describe("Ordered path vertices; polygon closes automatically."), ...styled }).strict(),
  z.object({ kind: z.literal("rectangle").describe("Axis-aligned rectangle."), x: finite("Left x coordinate."), y: finite("Bottom y coordinate."), width: positive("Rectangle width."), height: positive("Rectangle height."), ...styled }).strict(),
  z.object({ kind: z.literal("rounded-rectangle").describe("Axis-aligned rounded rectangle."), x: finite("Left x coordinate."), y: finite("Bottom y coordinate."), width: positive("Rectangle width."), height: positive("Rectangle height."), radius: positive("Corner radius in bp."), ...styled }).strict(),
  z.object({ kind: z.literal("circle").describe("Circle."), center: point.describe("Circle center."), radius: positive("Circle radius in bp."), ...styled }).strict(),
  z.object({ kind: z.literal("ellipse").describe("Possibly rotated ellipse."), center: point.describe("Ellipse center."), rx: positive("Horizontal radius."), ry: positive("Vertical radius."), rotationDegrees: finite("Counter-clockwise rotation in degrees.").optional(), ...styled }).strict(),
  z.object({ kind: z.literal("quadratic").describe("Quadratic Bezier curve."), from: point.describe("Curve start."), control: point.describe("Quadratic control point."), to: point.describe("Curve end."), ...styled }).strict(),
  z.object({ kind: z.literal("cubic").describe("Cubic Bezier curve."), from: point.describe("Curve start."), control1: point.describe("First control point."), control2: point.describe("Second control point."), to: point.describe("Curve end."), ...styled }).strict(),
  z.object({ kind: z.enum(["uniform", "catmull-rom", "clothoid"]).describe("Supported multi-point spline family."), points: z.array(point).min(2).max(MCP_LIMITS.pathPointsMax).describe("Ordered spline control points."), closed: z.boolean().optional().describe("Close the spline when supported."), tension: finite("Spline tension; used only by catmull-rom.").optional(), ...styled }).strict(),
]).describe("Typed M4 geometric path compiled to native Ipe XML 70218.");

const objectReplacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path").describe("Replace with a typed geometric path."), path: pathSchema.describe("Complete replacement path payload.") }).strict(),
  z.object({ kind: z.literal("text").describe("Replace with bounded LaTeX-backed text."), text: z.string().min(1).max(MCP_LIMITS.latexTextChars).describe("Complete replacement text content."), position: point.describe("Replacement text reference position."), width: positive("Minipage width in bp.").optional(), stroke: z.string().max(maxStyle).optional().describe("Numeric color or defined text color style."), size: z.union([positive("Numeric font size."), z.string().max(maxStyle)]).optional().describe("Numeric size or defined text-size style.") }).strict(),
  z.object({ kind: z.literal("symbol_use").describe("Replace with a native symbol use."), name: z.string().min(1).max(maxName).describe("Exact symbol name, including parameter suffix."), position: point.optional().describe("Optional symbol reference position."), stroke: z.string().max(maxStyle).optional().describe("Stroke parameter accepted only by symbols declaring s."), fill: z.string().max(maxStyle).optional().describe("Fill parameter accepted only by symbols declaring f."), size: z.union([positive("Numeric symbol size."), z.string().max(maxStyle)]).optional().describe("Size parameter accepted only by symbols declaring x.") }).strict(),
]).describe("Complete typed replacement content; the target object's persistent ID, layer, and z-order are preserved.");

const styleDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color").describe("Named grayscale or RGB color."), name: z.string().regex(/^[A-Za-z][^\s]*$/u).max(maxName).describe("Style name."), value: z.union([z.number().min(0).max(1), z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])]).describe("Gray component or RGB components in [0,1].") }).strict(),
  z.object({ kind: z.enum(["pen", "symbolsize", "arrowsize", "textsize"]).describe("Named numeric or symbolic size style."), name: z.string().regex(/^[A-Za-z][^\s]*$/u).max(maxName).describe("Style name."), value: z.union([positive("Positive numeric size."), z.string().min(1).max(maxStyle)]).describe("Numeric size or accepted Ipe size expression.") }).strict(),
  z.object({ kind: z.literal("dashstyle").describe("Named Ipe/PDF dash pattern."), name: z.string().regex(/^[A-Za-z][^\s]*$/u).max(maxName).describe("Style name."), value: z.string().min(1).max(maxDash).describe("Ipe/PDF dash syntax such as [4 2] 0.") }).strict(),
  z.object({ kind: z.literal("opacity").describe("Named opacity."), name: z.string().regex(/^[A-Za-z][^\s]*$/u).max(maxName).describe("Style name."), value: z.number().min(0.001).max(1).describe("Opacity in [0.001,1].") }).strict(),
  z.object({ kind: z.literal("symbol").describe("Reusable path-backed Ipe symbol."), name: z.string().min(1).max(maxName).describe("Native symbol name, including any parameter suffix."), path: pathSchema.describe("Path payload compiled as the symbol body.") }).strict(),
]).describe("Supported typed stylesheet definition.");

const layoutItem = z.object({ objectId: entityIdSchema.describe("Object to place."), source: box.describe("Current measured source box used to derive its transform.") }).strict().describe("One layout target with caller-supplied measured bounds.");
const layoutSpec = z.discriminatedUnion("primitive", [
  z.object({ primitive: z.enum(["row", "column"]).describe("Linear row or column layout."), container: box.describe("Container for all items."), items: z.array(layoutItem).min(1).max(maxIds).describe("Objects and current bounds in desired order."), gap: z.number().min(0).finite().optional().describe("Gap between items in bp."), padding: z.number().min(0).finite().optional().describe("Uniform container padding in bp."), mainAlign: z.enum(["start", "center", "end", "space-between"]).optional().describe("Alignment along the layout direction."), crossAlign: z.enum(["start", "center", "end", "stretch"]).optional().describe("Alignment across the layout direction.") }).strict(),
  z.object({ primitive: z.literal("grid").describe("Deterministic grid layout."), container: box.describe("Grid container."), items: z.array(layoutItem).min(1).max(maxIds).describe("Objects and current bounds in cell order."), columns: z.number().int().min(1).max(MCP_LIMITS.gridColumnsMax).describe("Fixed grid column count."), rowGap: z.number().min(0).finite().optional().describe("Gap between rows."), columnGap: z.number().min(0).finite().optional().describe("Gap between columns.") }).strict(),
  z.object({ primitive: z.literal("stack").describe("Overlapping stack layout."), container: box.describe("Stack container."), items: z.array(layoutItem).min(1).max(maxIds).describe("Objects and current bounds."), horizontalAlign: z.enum(["left", "center", "right"]).optional().describe("Horizontal placement inside the stack."), verticalAlign: z.enum(["bottom", "center", "top"]).optional().describe("Vertical placement inside the stack.") }).strict(),
]).describe("M3 semantic layout request converted into atomic object transforms.");

export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_metadata").describe("Update document metadata."), title: z.string().max(maxTitle).optional().describe("Document title."), author: z.string().max(maxTitle).optional().describe("Document author.") }).strict(),
  z.object({ op: z.literal("add_page").describe("Add a page with its initial layer and view."), name: z.string().min(1).max(maxName).optional().describe("Unique page destination name."), title: z.string().max(maxTitle).optional().describe("Page title.") }).strict(),
  z.object({ op: z.literal("update_page").describe("Update page metadata."), pageId: entityIdSchema.describe("Page to update."), patch: pagePatch }).strict(),
  z.object({ op: z.literal("delete_page").describe("Delete a page while retaining at least one."), pageId: entityIdSchema.describe("Page to remove.") }).strict(),
  z.object({ op: z.literal("reorder_pages").describe("Replace global page order."), pageIds: z.array(entityIdSchema).min(1).max(MCP_LIMITS.reorderPagesMax).describe("Every page ID exactly once, in desired order.") }).strict(),
  z.object({ op: z.literal("add_layer").describe("Add a layer to a page."), pageId: entityIdSchema.describe("Owning page."), name: z.string().regex(/^\S+$/u).max(maxName).describe("Unique whitespace-free layer name."), intentional: z.boolean().optional().describe("Required true for reserved Ipe layers such as BBOX.") }).strict(),
  z.object({ op: z.literal("update_layer").describe("Update layer editing semantics."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Layer to update."), name: z.string().regex(/^\S+$/u).max(maxName).optional().describe("New unique layer name."), edit: z.boolean().optional().describe("Whether native Ipe permits editing this layer."), snap: z.enum(["never", "visible", "always"]).optional().describe("Native snapping policy for the layer.") }).strict(),
  z.object({ op: z.literal("delete_layer").describe("Delete an empty non-final layer."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Layer to remove.") }).strict(),
  z.object({ op: z.literal("reorder_layers").describe("Replace layer list order without changing object z-order."), pageId: entityIdSchema.describe("Owning page."), layerIds: z.array(entityIdSchema).min(1).max(maxIds).describe("Every layer ID exactly once, in desired order.") }).strict(),
  z.object({ op: z.literal("add_view").describe("Add a static page view."), pageId: entityIdSchema.describe("Owning page."), name: z.string().min(1).max(maxName).optional().describe("Optional unique destination name."), visibleLayerIds: z.array(entityIdSchema).min(1).max(maxIds).describe("Layers visible in this static view."), activeLayerId: entityIdSchema.describe("Visible active layer used for editing."), marked: z.boolean().optional().describe("Whether this view is selected for handouts.") }).strict(),
  z.object({ op: z.literal("update_view").describe("Update static view visibility/editing semantics."), pageId: entityIdSchema.describe("Owning page."), viewId: entityIdSchema.describe("View to update."), visibleLayerIds: z.array(entityIdSchema).min(1).max(maxIds).optional().describe("Complete replacement visible-layer set."), activeLayerId: entityIdSchema.optional().describe("Active layer, which must remain visible."), marked: z.boolean().optional().describe("Whether this view is selected for handouts.") }).strict(),
  z.object({ op: z.literal("delete_view").describe("Delete a non-final view."), pageId: entityIdSchema.describe("Owning page."), viewId: entityIdSchema.describe("View to remove.") }).strict(),
  z.object({ op: z.literal("reorder_views").describe("Replace view order and therefore PDF expansion order."), pageId: entityIdSchema.describe("Owning page."), viewIds: z.array(entityIdSchema).min(1).max(MCP_LIMITS.reorderViewsMax).describe("Every view ID exactly once, in desired order.") }).strict(),
  z.object({ op: z.literal("add_rectangle").describe("Convenience rectangle insertion."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Target layer; z-order remains global."), x: finite("Left x coordinate."), y: finite("Bottom y coordinate."), width: positive("Rectangle width."), height: positive("Rectangle height."), stroke: z.string().max(maxStyle).optional().describe("Numeric color or defined style name."), fill: z.string().max(maxStyle).optional().describe("Numeric color or defined style name."), position: position.optional() }).strict(),
  z.object({ op: z.literal("add_segment").describe("Convenience segment insertion."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Target layer."), from: point.describe("Segment start."), to: point.describe("Segment end."), stroke: z.string().max(maxStyle).optional().describe("Numeric color or defined style name."), position: position.optional() }).strict(),
  z.object({ op: z.literal("add_path").describe("Insert any supported typed M4 path."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Target layer."), path: pathSchema, position: position.optional() }).strict(),
  z.object({ op: z.literal("add_text").describe("Insert bounded LaTeX-backed text."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Target layer."), text: z.string().min(1).max(MCP_LIMITS.latexTextChars).describe("Untrusted LaTeX fragment subject to native policy."), position: point.describe("Text reference position."), width: positive("Minipage width in bp.").optional(), stroke: z.string().max(maxStyle).optional().describe("Numeric color or defined text color style."), size: z.union([positive("Numeric font size."), z.string().max(maxStyle)]).optional().describe("Numeric size or defined text-size style."), positionInZOrder: position.optional() }).strict(),
  z.object({ op: z.literal("add_image").describe("Validate/deduplicate a bounded bitmap asset and insert its image object."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Target layer."), mediaType: z.enum(["image/png", "image/jpeg"]).describe("Encoded bitmap media type."), dataBase64: z.string().min(4).max(MCP_LIMITS.imageBase64Chars).describe("Base64 bitmap payload; decoded bytes are preflighted before allocation."), target: box.describe("Image target box."), fit: z.enum(["contain", "cover", "stretch"]).optional().describe("Fit policy; cover emits a clipped group."), opacity: z.string().max(maxStyle).optional().describe("Defined Ipe opacity style."), position: position.optional() }).strict(),
  z.object({ op: z.literal("add_symbol_use").describe("Insert a native use object for a defined or built-in symbol."), pageId: entityIdSchema.describe("Owning page."), layerId: entityIdSchema.describe("Target layer."), name: z.string().min(1).max(maxName).describe("Exact symbol name, including parameter suffix."), position: point.optional().describe("Optional symbol reference position."), stroke: z.string().max(maxStyle).optional().describe("Stroke parameter accepted only by symbols declaring s."), fill: z.string().max(maxStyle).optional().describe("Fill parameter accepted only by symbols declaring f."), size: z.union([positive("Numeric symbol size."), z.string().max(maxStyle)]).optional().describe("Size parameter accepted only by symbols declaring x."), positionInZOrder: position.optional() }).strict(),
  z.object({ op: z.literal("replace_object").describe("Replace one object atomically while preserving its persistent identity, layer, and z-order."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Exact object to replace."), replacement: objectReplacementSchema.describe("Complete typed replacement content.") }).strict(),
  z.object({ op: z.literal("duplicate_object").describe("Duplicate an object with a fresh persistent identity."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Object to duplicate."), position: position.optional() }).strict(),
  z.object({ op: z.literal("delete_object").describe("Delete an unreferenced object."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Object to remove.") }).strict(),
  z.object({ op: z.literal("move_object").describe("Move an object in global z-order."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Object to move."), position }).strict(),
  z.object({ op: z.literal("set_object_layer").describe("Change object layer membership without changing global z-order."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Object to update."), layerId: entityIdSchema.describe("New layer on the same page.") }).strict(),
  z.object({ op: z.literal("transform_object").describe("Compose an affine transform onto an object."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Object to transform."), matrix, space: z.enum(["page", "local"]).describe("Page pre-multiplies; local post-multiplies the current matrix.") }).strict(),
  z.object({ op: z.literal("group_objects").describe("Replace contiguous same-layer objects with a group."), pageId: entityIdSchema.describe("Owning page."), objectIds: z.array(entityIdSchema).min(2).max(maxIds).describe("Distinct contiguous object IDs in global z-order."), clip: pathSchema.optional().describe("Optional closed clip path."), url: z.string().url().max(maxPath).optional().describe("Optional group hyperlink URL."), decoration: z.string().max(maxStyle).optional().describe("Optional defined decoration style.") }).strict(),
  z.object({ op: z.literal("ungroup_object").describe("Expand a safe group into fresh child objects."), pageId: entityIdSchema.describe("Owning page."), objectId: entityIdSchema.describe("Group object to expand.") }).strict(),
  z.object({ op: z.literal("add_stylesheet").describe("Append a typed stylesheet with colors, sizes, opacity, dash, or path symbols."), name: z.string().regex(/^[A-Za-z][^\s]*$/u).max(maxName).describe("Unique stylesheet name."), definitions: z.array(styleDefinitionSchema).min(1).max(maxIds).describe("Typed style definitions compiled atomically.") }).strict(),
  z.object({ op: z.literal("layout_objects").describe("Apply an M3 row, column, grid, or stack layout as atomic object transforms."), pageId: entityIdSchema.describe("Owning page."), layout: layoutSpec }).strict(),
]);

export type PublicOperation = z.infer<typeof operationSchema>;

const easing = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).describe("Semantic easing sampled into discrete static views.");
const motionCommon = {
  pageId: entityIdSchema.describe("Page that receives the generated static views."),
  steps: z.number().int().min(2).max(MCP_LIMITS.stepsMax).describe("Number of independently renderable static states, including endpoints."),
  easing: easing.optional(),
  name: z.string().min(1).max(maxName).optional().describe("Base name for generated layers/views."),
};
export const viewBuildSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reveal").describe("Progressive layer/object reveal."), pageId: motionCommon.pageId, groups: z.array(z.array(z.object({ kind: z.enum(["layer", "object"]).describe("Reveal target entity kind."), id: entityIdSchema.describe("Exact target layer or object ID.") }).strict()).min(1).describe("Targets introduced together in one reveal step.")).min(1).max(MCP_LIMITS.revealGroupsMax).describe("Ordered reveal groups."), cumulative: z.boolean().optional().describe("When true, each generated view retains all prior groups."), name: motionCommon.name }).strict(),
  z.object({ kind: z.literal("motion").describe("Discrete duplicate-based object motion."), pageId: motionCommon.pageId, objectIds: z.array(entityIdSchema).min(1).max(MCP_LIMITS.motionObjectIdsMax).describe("Distinct objects moved together."), from: point.describe("Initial translation pose."), to: point.describe("Final translation pose."), steps: motionCommon.steps, easing: motionCommon.easing, name: motionCommon.name }).strict(),
  z.object({ kind: z.literal("panel_scroll").describe("Clipped single-object panel scroll."), pageId: motionCommon.pageId, objectId: entityIdSchema.describe("Panel content object."), axis: z.enum(["x", "y"]).describe("Scroll axis."), from: finite("Initial axis translation."), to: finite("Final axis translation."), clip: box.describe("Fixed visible panel rectangle."), steps: motionCommon.steps, easing: motionCommon.easing, name: motionCommon.name }).strict(),
  z.object({ kind: z.literal("camera_pan").describe("Discrete camera-like translation of selected or non-reserved page objects."), pageId: motionCommon.pageId, objectIds: z.array(entityIdSchema).min(1).max(MCP_LIMITS.cameraObjectIdsMax).optional().describe("Objects to pan; omit to select all non-reserved-layer objects."), includeReservedLayers: z.boolean().optional().describe("Include BACKGROUND/BBOX/VIEWBBOX objects when objectIds is omitted."), from: point.describe("Initial camera translation."), to: point.describe("Final camera translation."), steps: motionCommon.steps, easing: motionCommon.easing, name: motionCommon.name }).strict(),
  z.object({ kind: z.literal("transition").describe("Assign a named PDF transition effect to existing views."), pageId: motionCommon.pageId, viewIds: z.array(entityIdSchema).min(1).max(MCP_LIMITS.transitionViewIdsMax).describe("Views receiving the transition."), effect: z.enum(["normal", "split-horizontal-in", "split-horizontal-out", "split-vertical-in", "split-vertical-out", "blinds-horizontal", "blinds-vertical", "box-in", "box-out", "wipe-left-right", "wipe-bottom-top", "wipe-right-left", "wipe-top-bottom", "dissolve", "glitter-left-right", "glitter-top-bottom", "glitter-diagonal", "fly-in-left-right", "fly-out-left-right", "fly-in-top-bottom", "fly-out-top-bottom", "push-left-right", "push-top-bottom", "cover-left-right", "cover-left-bottom", "uncover-left-right", "uncover-top-bottom", "fade"]).describe("Ipe/PDF transition effect."), duration: z.number().min(0).finite().optional().describe("Effect duration in seconds."), transition: z.number().int().min(0).optional().describe("Transition duration as native non-negative integer."), viewer: z.enum(["ipe-presenter", "acrobat", "okular", "evince", "pdfpc", "browser"]).optional().describe("Optional viewer profile used only for conservative compatibility diagnostics.") }).strict(),
]).describe("Bounded M7 static-view build or transition assignment.");

export type PublicViewBuild = z.infer<typeof viewBuildSchema>;
