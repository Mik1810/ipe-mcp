#!/usr/bin/env ipescript
-- Load an Ipe document, copy its first custom object, and save the result.

local function fail(message)
  io.stderr:write("IPE_ROUNDTRIP_ERROR=" .. message .. "\n")
  os.exit(1)
end

if #argv ~= 3 then
  fail("usage: ipescript native-roundtrip-copy INPUT OUTPUT NEW_CUSTOM_ID")
end

local input = argv[1]
local output = argv[2]
local new_custom = argv[3]
if not new_custom:match("^ipe%-mcp:%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
  fail("invalid-custom-id=" .. new_custom)
end
local loaded, doc = pcall(ipe.Document, input)
if not loaded or not doc then
  fail("load=" .. tostring(doc))
end

local function layer_matrix_summary(page, view)
  local matrices = page:layerMatrices(view)
  local result = {}
  for _, layer in ipairs(page:layers()) do
    local matrix = matrices[layer]
    result[#result + 1] = layer .. "=" .. (matrix and tostring(matrix) or "identity")
  end
  return table.concat(result, ",")
end

local function page_matrices_summary(page)
  local result = {}
  for view = 1, page:countViews() do
    result[#result + 1] = "view=" .. view .. "[" .. layer_matrix_summary(page, view) .. "]"
  end
  return table.concat(result, ",")
end

local function page_summary(document)
  local result = {}
  for pno = 1, #document do
    local page = document[pno]
    result[#result + 1] = "page=" .. pno
      .. ";views=" .. page:countViews()
      .. ";layers=" .. table.concat(page:layers(), ",")
      .. ";matrices=" .. page_matrices_summary(page)
  end
  return table.concat(result, "|")
end

local function custom_objects(document)
  local count = 0
  local first = nil
  local ids = {}
  for pno = 1, #document do
    local page = document[pno]
    for index, object, _, layer in page:objects() do
      local custom = object:getCustom()
      -- The 7.2 Lua binding returns the literal string "undefined" when the
      -- optional custom attribute is absent.
      if custom and custom ~= "" and custom ~= "undefined" then
        count = count + 1
        ids[custom] = true
        if not first then
          first = {
            page = pno,
            index = index,
            object = object,
            layer = layer,
            custom = custom,
            bbox = tostring(page:bbox(index)),
            matrix = tostring(object:matrix()),
          }
        end
      end
    end
  end
  return count, first, ids
end

local function custom_object_by_id(document, target)
  for pno = 1, #document do
    local page = document[pno]
    for index, object, _, layer in page:objects() do
      if object:getCustom() == target then
        return {
          page = pno,
          index = index,
          object = object,
          layer = layer,
          bbox = tostring(page:bbox(index)),
          matrix = tostring(object:matrix()),
        }
      end
    end
  end
  return nil
end

local function payload_xml(object)
  local copy = object:clone()
  copy:setCustom("ipe-mcp:00000000-0000-4000-8000-000000000000")
  return copy:xml()
end

local pages_before = #doc
local views_before = doc:countTotalViews()
local page_summary_before = page_summary(doc)
local custom_before, source, ids_before = custom_objects(doc)
if not source then
  fail("no-custom-object")
end

if ids_before[new_custom] then
  fail("custom-id-collision=" .. new_custom)
end

local page = doc[source.page]
local clone = source.object:clone()
clone:setCustom(new_custom)
-- Insert immediately after the source: the layer is explicit and z-order
-- remains deterministic relative to all other objects.
local clone_index = source.index + 1
page:insert(clone_index, clone, nil, source.layer)

local clone_after = page[clone_index]
if not clone_after or clone_after:getCustom() ~= new_custom then
  fail("clone-verification")
end

local save_ok, save_result, save_error = pcall(doc.save, doc, output, "xml")
if not save_ok then
  fail("save-exception=" .. tostring(save_result))
end
if not save_result then
  fail("save=" .. tostring(save_error))
end

local reloaded_ok, saved_doc = pcall(ipe.Document, output)
if not reloaded_ok or not saved_doc then
  fail("reload=" .. tostring(saved_doc))
end
local custom_after = custom_objects(saved_doc)
local saved_source = custom_object_by_id(saved_doc, source.custom)
local saved_clone = custom_object_by_id(saved_doc, new_custom)
if not saved_source then
  fail("reloaded-source-missing=" .. source.custom)
end
if not saved_clone then
  fail("reloaded-clone-missing=" .. new_custom)
end
if payload_xml(saved_source.object) ~= payload_xml(saved_clone.object) then
  fail("reloaded-clone-payload")
end

print("IPE_ROUNDTRIP_FORMAT=1")
print("IPE_ROUNDTRIP_PAGES_BEFORE=" .. pages_before)
print("IPE_ROUNDTRIP_PAGES_AFTER=" .. #saved_doc)
print("IPE_ROUNDTRIP_VIEWS_BEFORE=" .. views_before)
print("IPE_ROUNDTRIP_VIEWS_AFTER=" .. saved_doc:countTotalViews())
print("IPE_ROUNDTRIP_CUSTOM_BEFORE=" .. custom_before)
print("IPE_ROUNDTRIP_CUSTOM_AFTER=" .. custom_after)
print("IPE_ROUNDTRIP_PAGE_SUMMARY_BEFORE=" .. page_summary_before)
print("IPE_ROUNDTRIP_PAGE_SUMMARY_AFTER=" .. page_summary(saved_doc))
print("IPE_ROUNDTRIP_SOURCE_PAGE=" .. saved_source.page)
print("IPE_ROUNDTRIP_SOURCE_INDEX=" .. saved_source.index)
print("IPE_ROUNDTRIP_SOURCE_ID=" .. source.custom)
print("IPE_ROUNDTRIP_SOURCE_LAYER=" .. saved_source.layer)
print("IPE_ROUNDTRIP_SOURCE_BBOX=" .. saved_source.bbox)
print("IPE_ROUNDTRIP_SOURCE_MATRIX=" .. saved_source.matrix)
print("IPE_ROUNDTRIP_CLONE_PAGE=" .. saved_clone.page)
print("IPE_ROUNDTRIP_CLONE_INDEX=" .. saved_clone.index)
print("IPE_ROUNDTRIP_CLONE_ID=" .. saved_clone.object:getCustom())
print("IPE_ROUNDTRIP_CLONE_LAYER=" .. saved_clone.layer)
print("IPE_ROUNDTRIP_CLONE_BBOX=" .. saved_clone.bbox)
print("IPE_ROUNDTRIP_CLONE_MATRIX=" .. saved_clone.matrix)
print("IPE_ROUNDTRIP_CLONE_PAYLOAD_MATCH=PASS")
