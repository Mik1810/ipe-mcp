/* Trusted MuPDF ES5 worker. Only the fixed staged PDF is read. */
var profile = {
  q: 0, Q: 0, cm: 6, w: 1, J: 1, j: 1, M: 1,
  g: 1, G: 1, rg: 3, RG: 3,
  m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4,
  W: 0, n: 0, f: 0, F: 0, "f*": 0, S: 0, s: 0,
  B: 0, "B*": 0, b: 0, "b*": 0,
  BT: 0, ET: 0, Tf: 2, Td: 2, Tm: 6, Tc: 1, Tw: 1, Tz: 1, TL: 1, Tr: 1, Ts: 1,
  "T*": 0, Tj: 1, Do: 1
};
var pathOps = { m: true, l: true, c: true, v: true, y: true, h: true, re: true };
var paintOps = {
  f: ["fill"], F: ["fill"], "f*": ["fill"], S: ["stroke"], s: ["stroke"],
  B: ["fill", "stroke"], "B*": ["fill", "stroke"], b: ["fill", "stroke"], "b*": ["fill", "stroke"]
};
var unsupported = {
  TJ: "PDF_TEXT_UNSUPPORTED", BI: "PDF_INLINE_IMAGE_UNSUPPORTED",
  sh: "PDF_SHADING_UNSUPPORTED", "W*": "PDF_EVEN_ODD_CLIP_UNSUPPORTED",
  gs: "PDF_GRAPHICS_STATE_UNSUPPORTED", d: "PDF_DASH_UNSUPPORTED",
  BMC: "PDF_MARKED_CONTENT_UNSUPPORTED", BDC: "PDF_MARKED_CONTENT_UNSUPPORTED"
};
var textOps = { Tf: true, Td: true, Tm: true, Tc: true, Tw: true, Tz: true, TL: true, Tr: true, Ts: true, "T*": true, Tj: true };
var standardFonts = [
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"
];
var location = "pdf";
var decodedBytes = 0;
var commandCount = 0;
var pointCount = 0;
var eventCount = 0;
var glyphCount = 0;
var imagePixels = 0;
var outlinedText = false;
var importedImages = false;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function reject(code) {
  throw { rejection: { code: code, location: location } };
}

function number(value) {
  if (typeof value !== "number" || !isFinite(value) || Math.abs(value) > 1000000) reject("PDF_NUMERIC_LIMIT");
  return value;
}

function requireKeys(object, allowed, code) {
  if (!object || !object.isDictionary()) reject("PDF_INVALID_DICTIONARY");
  object.forEach(function (_value, key) {
    if (allowed.indexOf(key) < 0) reject(code);
  });
}

function decodedStream(stream) {
  if (!stream || !stream.isStream()) reject("PDF_CONTENT_STREAM_REQUIRED");
  requireKeys(stream, ["Length", "Filter"], "PDF_STREAM_FEATURE_UNSUPPORTED");
  var filter = stream.get("Filter");
  if (filter && (!filter.isName() || filter.asName() !== "FlateDecode")) reject("PDF_FILTER_UNSUPPORTED");
  var buffer = stream.readStream();
  decodedBytes += buffer.length;
  if (decodedBytes > 512 * 1024) reject("PDF_CONTENT_BYTE_LIMIT");
  var text = buffer.asString();
  if (text.length !== buffer.length || /[^\t\n\f\r\x20-\x7e]/.test(text)) reject("PDF_CONTENT_ENCODING_UNSUPPORTED");
  return text;
}

function checkStream(contents, pageLocation, resources) {
  var source = [];
  if (!contents) reject("PDF_CONTENT_STREAM_REQUIRED");
  if (contents.isArray()) {
    if (contents.length > 32) reject("PDF_CONTENT_STREAM_LIMIT");
    for (var i = 0; i < contents.length; i++) source.push(decodedStream(contents.get(i)));
  } else {
    source.push(decodedStream(contents));
  }

  var lex = /%[^\r\n]*|\([^()\r\n\\]*\)|\/[A-Za-z][A-Za-z0-9_]*|[^\t\n\f\r %()[\]<>\/]+|[()[\]<>\/]/g;
  var stream = source.join("\n");
  var args = [], paint = [], clipCount = 0, depth = 0, path = false, clip = false;
  var token, ordinal = 0, text = false, font = false;
  while ((token = lex.exec(stream)) !== null) {
    var op = token[0];
    if (op.charAt(0) === "%") continue;
    location = pageLocation + ".operator[" + ordinal + "]";
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(op)) {
      if (args.length >= 6) reject("PDF_OPERATOR_ARITY");
      args.push(number(Number(op)));
      continue;
    }
    if (/^\/[A-Za-z][A-Za-z0-9_]*$/.test(op) || (op.length >= 2 && op.charAt(0) === "(" && op.charAt(op.length - 1) === ")")) {
      if (args.length >= 6) reject("PDF_OPERATOR_ARITY");
      args.push(op);
      continue;
    }
    ordinal++;
    if (++commandCount > 8000) reject("PDF_OPERATOR_LIMIT");
    if (!own(profile, op)) reject(own(unsupported, op) ? unsupported[op] : "PDF_OPERATOR_UNSUPPORTED");
    if (args.length !== profile[op]) reject("PDF_OPERATOR_ARITY");
    if (op !== "Tf" && op !== "Tj" && op !== "Do" && args.some(function (x) { return typeof x !== "number"; })) reject("PDF_OPERATOR_OPERAND");
    if (op === "BT" || op === "ET") {
      if (path || (op === "BT") === text) reject("PDF_TEXT_STATE_UNSUPPORTED");
      text = op === "BT";
      font = false;
    } else if (own(textOps, op)) {
      if (!text || path) reject("PDF_TEXT_STATE_UNSUPPORTED");
      if (op === "Tf") {
        if (typeof args[0] !== "string" || !own(resources.fonts, args[0].slice(1))
          || typeof args[1] !== "number" || args[1] <= 0 || args[1] > 4096) reject("PDF_FONT_UNSUPPORTED");
        font = true;
      } else if (op === "Tj") {
        if (!font || typeof args[0] !== "string" || args[0].charAt(0) !== "(") reject("PDF_TEXT_UNSUPPORTED");
        var literal = args[0].slice(1, -1);
        if (literal.length === 0 || literal.length > 1024 || !/^[ -~]+$/.test(literal)) reject("PDF_TEXT_UNSUPPORTED");
        glyphCount += literal.length;
        if (glyphCount > 4000) reject("PDF_GLYPH_LIMIT");
        var previous = paint[paint.length - 1];
        if (previous && previous.kind === "text") previous.text += literal;
        else paint.push({ kind: "text", text: literal });
      } else if (op === "Tr" && args[0] !== 0) {
        reject("PDF_TEXT_RENDER_MODE_UNSUPPORTED");
      }
    } else if (text && ["g", "G", "rg", "RG"].indexOf(op) < 0) {
      reject("PDF_TEXT_STATE_UNSUPPORTED");
    } else if (op === "Do") {
      if (path || typeof args[0] !== "string" || !own(resources.images, args[0].slice(1))) reject("PDF_XOBJECT_UNSUPPORTED");
      paint.push({ kind: "image" });
    } else if (own(pathOps, op)) {
      if (clip || (!path && op !== "m" && op !== "re")) reject("PDF_PATH_STATE_UNSUPPORTED");
      path = true;
    } else if (op === "W") {
      if (!path || clip) reject("PDF_PATH_STATE_UNSUPPORTED");
      clip = true;
      clipCount++;
    } else if (own(paintOps, op) || op === "n") {
      if (!path && op !== "n") reject("PDF_PATH_STATE_UNSUPPORTED");
      if (own(paintOps, op)) paintOps[op].forEach(function (kind) { paint.push({ kind: kind }); });
      path = clip = false;
    } else if (path) {
      reject("PDF_PATH_STATE_UNSUPPORTED");
    } else if (op === "q") {
      if (++depth > 24) reject("PDF_GRAPHICS_STACK_LIMIT");
    } else if (op === "Q") {
      if (--depth < 0) reject("PDF_GRAPHICS_STACK_UNBALANCED");
    } else if ((op === "J" || op === "j") && [0, 1, 2].indexOf(args[0]) < 0) {
      reject("PDF_STROKE_UNSUPPORTED");
    } else if ((op === "w" && args[0] <= 0) || (op === "M" && args[0] !== 10)) {
      reject("PDF_STROKE_UNSUPPORTED");
    } else if (["g", "G", "rg", "RG"].indexOf(op) >= 0 && args.some(function (x) { return x < 0 || x > 1; })) {
      reject("PDF_COLOR_UNSUPPORTED");
    }
    args = [];
  }
  if (args.length !== 0 || path || text || depth !== 0) reject("PDF_INCOMPLETE_CONTENT");
  location = pageLocation;
  return { paint: paint, clipCount: clipCount };
}

function pathCommands(path) {
  var commands = [];
  function add(op, coordinates) {
    if (++pointCount > 12000) reject("PDF_GEOMETRY_LIMIT");
    commands.push([op].concat(Array.prototype.map.call(coordinates, number)));
  }
  path.walk({
    moveTo: function () { add("m", arguments); },
    lineTo: function () { add("l", arguments); },
    curveTo: function () { add("c", arguments); },
    closePath: function () { add("h", []); }
  });
  return commands;
}

function paintColor(space, color, alpha) {
  var name = space.getName();
  if (alpha !== 1 || (name !== "DeviceGray" && name !== "DeviceRGB")) reject("PDF_PAINT_UNSUPPORTED");
  if (color.length !== (name === "DeviceGray" ? 1 : 3)) reject("PDF_PAINT_UNSUPPORTED");
  return color.map(number);
}

function base64(buffer) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var output = [];
  for (var i = 0; i < buffer.length; i += 3) {
    var a = buffer[i], b = i + 1 < buffer.length ? buffer[i + 1] : 0, c = i + 2 < buffer.length ? buffer[i + 2] : 0;
    output.push(alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)]
      + (i + 1 < buffer.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=")
      + (i + 2 < buffer.length ? alphabet[c & 63] : "="));
  }
  return output.join("");
}

function textSvg(text, matrix, space, color, alpha, bounds) {
  var buffer = new Buffer();
  var writer = new DocumentWriter(buffer, "svg", "text=path");
  var device = writer.beginPage(bounds);
  device.fillText(text, matrix, space, color, alpha);
  writer.endPage();
  writer.close();
  if (buffer.length > 256 * 1024) reject("PDF_GLYPH_OUTLINE_LIMIT");
  return buffer.asString();
}

function tracePage(page, expected) {
  var bounds = page.getBounds().map(number);
  var events = [], paintIndex = 0, textOffset = 0, clips = 0, depth = 0;
  function emit(event) {
    if (++eventCount > 2000) reject("PDF_PAINT_EVENT_LIMIT");
    events.push(event);
  }
  function expectKind(kind) {
    if (!expected.paint[paintIndex] || expected.paint[paintIndex].kind !== kind) reject("PDF_TRACE_PAINT_MISMATCH");
  }
  function painted(kind, path, matrix, space, color, alpha) {
    expectKind(kind);
    paintIndex++;
    return { kind: kind, path: pathCommands(path), matrix: matrix.map(number), color: paintColor(space, color, alpha) };
  }
  function unexpected() { reject("PDF_TRACE_EVENT_UNSUPPORTED"); }
  page.run(new Device({
    fillPath: function (path, evenOdd, matrix, space, color, alpha) {
      var event = painted("fill", path, matrix, space, color, alpha);
      event.evenOdd = evenOdd;
      emit(event);
    },
    strokePath: function (path, stroke, matrix, space, color, alpha) {
      var event = painted("stroke", path, matrix, space, color, alpha);
      event.width = number(stroke.getLineWidth());
      event.cap = ["Butt", "Round", "Square"].indexOf(stroke.getLineCap());
      event.join = ["Miter", "Round", "Bevel"].indexOf(stroke.getLineJoin());
      var dash = stroke.getDashPattern();
      if (event.cap < 0 || event.join < 0 || (dash && dash.length !== 0) || stroke.getMiterLimit() !== 10) reject("PDF_STROKE_UNSUPPORTED");
      emit(event);
    },
    clipPath: function (path, evenOdd, matrix) {
      clips++;
      if (++depth > 32) reject("PDF_CLIP_LIMIT");
      emit({ kind: "clip", path: pathCommands(path), matrix: matrix.map(number), evenOdd: evenOdd });
    },
    popClip: function () {
      if (--depth < 0) reject("PDF_TRACE_CLIP_MISMATCH");
      emit({ kind: "pop" });
    },
    fillText: function (text, matrix, space, color, alpha) {
      expectKind("text");
      var source = expected.paint[paintIndex].text;
      var start = textOffset;
      text.walk({ showGlyph: function (_font, _matrix, gid, unicode, writingMode) {
        if (gid <= 0 || writingMode !== 0 || source.charCodeAt(textOffset++) !== unicode) reject("PDF_TEXT_MAPPING_UNSUPPORTED");
      } });
      if (textOffset === start || textOffset > source.length) reject("PDF_TEXT_MAPPING_UNSUPPORTED");
      var visible = source.slice(start, textOffset).trim().length !== 0;
      if (textOffset === source.length) { paintIndex++; textOffset = 0; }
      var ink = paintColor(space, color, alpha);
      if (visible) {
        emit({ kind: "text", svg: textSvg(text, matrix, space, color, alpha, bounds), color: ink });
      }
      outlinedText = true;
    },
    fillImage: function (image, matrix, alpha) {
      expectKind("image");
      paintIndex++;
      var width = number(image.getWidth()), height = number(image.getHeight());
      imagePixels += width * height;
      if (width < 1 || height < 1 || imagePixels > 100000) reject("PDF_IMAGE_PIXEL_LIMIT");
      if (alpha !== 1 || image.getBitsPerComponent() !== 8 || image.getMask() || image.getImageMask()
        || ["DeviceGray", "DeviceRGB"].indexOf(image.getColorSpace().getName()) < 0) reject("PDF_IMAGE_UNSUPPORTED");
      emit({ kind: "image", matrix: matrix.map(number), png: base64(image.toPixmap().asPNG()), width: width, height: height });
      importedImages = true;
    },
    clipStrokePath: unexpected, strokeText: unexpected,
    clipText: unexpected, clipStrokeText: unexpected, ignoreText: unexpected,
    fillShade: unexpected, fillImageMask: unexpected, clipImageMask: unexpected,
    beginMask: unexpected, beginGroup: unexpected, beginTile: unexpected,
    beginLayer: unexpected
  }), [1, 0, 0, 1, 0, 0]);
  if (paintIndex !== expected.paint.length) reject("PDF_TRACE_PAINT_MISMATCH");
  if (depth !== 0 || clips < expected.clipCount || clips > expected.clipCount + 1) reject("PDF_TRACE_CLIP_MISMATCH");
  return { bounds: bounds, events: events };
}

function checkPage(obj) {
  requireKeys(obj, ["Type", "Parent", "Contents", "Resources", "MediaBox", "CropBox", "Rotate", "UserUnit", "Annots"],
    "PDF_PAGE_FEATURE_UNSUPPORTED");
  if (obj.get("Annots")) reject("PDF_ANNOTATIONS_UNSUPPORTED");
  var parent = obj.get("Parent"), ancestors = 0;
  while (parent) {
    if (++ancestors > 24) reject("PDF_PAGE_TREE_LIMIT");
    requireKeys(parent, ["Type", "Parent", "Kids", "Count", "Resources", "MediaBox", "CropBox", "Rotate"],
      "PDF_PAGE_TREE_FEATURE_UNSUPPORTED");
    parent = parent.get("Parent");
  }
  var rotation = obj.getInheritable("Rotate"), userUnit = obj.get("UserUnit");
  if (rotation && (!rotation.isInteger() || rotation.asNumber() % 90 !== 0)) reject("PDF_PAGE_ROTATION_UNSUPPORTED");
  if (userUnit && (!userUnit.isNumber() || userUnit.asNumber() < 1 || userUnit.asNumber() > 100)) reject("PDF_PAGE_UNIT_UNSUPPORTED");
  var resources = obj.getInheritable("Resources");
  var fonts = {}, images = {};
  if (!resources) return { fonts: fonts, images: images };
  requireKeys(resources, ["ProcSet", "Font", "XObject"], "PDF_RESOURCES_UNSUPPORTED");
  var fontDictionary = resources.get("Font");
  if (fontDictionary) {
    if (!fontDictionary.isDictionary()) reject("PDF_FONT_UNSUPPORTED");
    fontDictionary.forEach(function (font, key) {
      requireKeys(font, ["Type", "Subtype", "BaseFont", "Encoding"], "PDF_FONT_UNSUPPORTED");
      var encoding = font.get("Encoding");
      if (!font.get("Subtype") || font.get("Subtype").asName() !== "Type1" || !font.get("BaseFont")
        || standardFonts.indexOf(font.get("BaseFont").asName()) < 0
        || (encoding && encoding.asName() !== "WinAnsiEncoding")) reject("PDF_FONT_UNSUPPORTED");
      Object.defineProperty(fonts, key, { value: true });
    });
  }
  var xobjects = resources.get("XObject");
  if (xobjects) {
    if (!xobjects.isDictionary()) reject("PDF_XOBJECT_UNSUPPORTED");
    xobjects.forEach(function (image, key) {
      if (!image.isStream() || !image.get("Subtype") || image.get("Subtype").asName() !== "Image") reject("PDF_XOBJECT_UNSUPPORTED");
      requireKeys(image, ["Type", "Subtype", "Length", "Filter", "Width", "Height", "BitsPerComponent", "ColorSpace", "Interpolate"], "PDF_IMAGE_UNSUPPORTED");
      var filter = image.get("Filter"), space = image.get("ColorSpace"), bits = image.get("BitsPerComponent");
      var width = image.get("Width"), height = image.get("Height");
      if (!width || !height || !width.isInteger() || !height.isInteger() || width.asNumber() < 1 || height.asNumber() < 1
        || width.asNumber() * height.asNumber() > 100000) reject("PDF_IMAGE_PIXEL_LIMIT");
      if ((filter && filter.asName() !== "FlateDecode") || !bits || bits.asNumber() !== 8
        || !space || ["DeviceGray", "DeviceRGB"].indexOf(space.asName()) < 0) reject("PDF_IMAGE_UNSUPPORTED");
      Object.defineProperty(images, key, { value: true });
    });
  }
  return { fonts: fonts, images: images };
}

function parsePdf() {
  var doc = new PDFDocument("source.pdf");
  if (doc.needsPassword()) reject("PDF_ENCRYPTED_UNSUPPORTED");
  var trailer = doc.getTrailer();
  if (trailer.get("Encrypt")) reject("PDF_ENCRYPTED_UNSUPPORTED");
  if (doc.wasRepaired()) reject("PDF_REPAIRED_UNSUPPORTED");
  requireKeys(trailer, ["Size", "Root", "Info", "ID"], "PDF_TRAILER_FEATURE_UNSUPPORTED");
  requireKeys(trailer.get("Root"), ["Type", "Pages"], "PDF_CATALOG_FEATURE_UNSUPPORTED");
  var info = trailer.get("Info");
  if (info) requireKeys(info, ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"],
    "PDF_METADATA_UNSUPPORTED");
  var count = doc.countPages(), pages = [];
  if (count < 1 || count > 24) reject("PDF_PAGE_LIMIT");
  for (var index = 0; index < count; index++) {
    var pageLocation = "pdf.page[" + index + "]";
    location = pageLocation;
    var page = doc.findPage(index);
    var resources = checkPage(page);
    var expected = checkStream(page.get("Contents"), pageLocation, resources);
    pages.push(tracePage(doc.loadPage(index), expected));
  }
  return { pages: pages, metadataInSource: Boolean(info || trailer.get("ID")),
    outlinedText: outlinedText, importedImages: importedImages };
}

try {
  print(JSON.stringify({ protocol: "ipe-mcp-pdf-import/1", result: parsePdf() }));
} catch (error) {
  print(JSON.stringify({ protocol: "ipe-mcp-pdf-import/1",
    error: error && error.rejection ? error.rejection : { code: "PDF_ENGINE_REJECTED", location: location } }));
}
