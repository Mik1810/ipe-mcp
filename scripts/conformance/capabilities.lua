#!/usr/bin/env ipescript
-- Capability probe for the Ipe Lua runtime.  It never writes a document.

local function fail(message)
  io.stderr:write("IPE_CAPABILITY_ERROR=" .. message .. "\n")
  os.exit(1)
end

if #argv > 1 then
  fail("usage: ipescript capabilities [optional-input.ipe]")
end

local function status(name, value)
  print("IPE_CAPABILITY_" .. name .. "=" .. value)
end

local function available(value)
  return type(value) == "function" and "PASS" or "FAIL"
end

print("IPE_CAPABILITIES_FORMAT=1")
local runtime = config and config.version
print("IPE_RUNTIME_VERSION=" .. (type(runtime) == "string" and runtime or "unreported"))
-- ipescript does not expose the distro package metadata to Lua.
print("IPE_PACKAGE_VERSION=unreported-via-lua")

local doc = ipe.Document()
local page = ipe.Page()
local object = ipe.Path({}, {})

status("DOCUMENT_CONSTRUCTOR", available(ipe.Document))
status("DOCUMENT_SAVE", available(doc.save))
status("DOCUMENT_COUNT_TOTAL_VIEWS", available(doc.countTotalViews))
status("PAGE_OBJECTS", available(page.objects))
status("PAGE_INSERT", available(page.insert))
status("PAGE_BBOX", available(page.bbox))
status("PAGE_LAYERS", available(page.layers))
status("PAGE_VIEWS", available(page.countViews))
status("PAGE_LAYER_MATRICES", available(page.layerMatrices))
status("OBJECT_CLONE", available(object.clone))
status("OBJECT_GET_CUSTOM", available(object.getCustom))
status("OBJECT_SET_CUSTOM", available(object.setCustom))
status("OBJECT_MATRIX", available(object.matrix))
status("OBJECT_SET_MATRIX", available(object.setMatrix))

if #argv == 1 then
  local ok, loaded = pcall(ipe.Document, argv[1])
  if not ok or not loaded then
    fail("load=" .. tostring(loaded))
  end
  status("DOCUMENT_LOAD", "PASS")
else
  status("DOCUMENT_LOAD", "UNTESTED_NO_INPUT")
end
