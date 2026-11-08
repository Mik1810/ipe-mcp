-- Internal live bridge transaction for Ipe 7.2.30 Qt.
-- The broker and menu entry point own pairing, the spool and the review prompt.
local limit = 16 * 1024 * 1024
local transaction = {}

local function withTemporaryFile(operation)
  local path = os.tmpname()
  local ok, result = pcall(operation, path)
  os.remove(path)
  if ok then return result end
end

local function readSnapshot(path)
  local file = assert(io.open(path, "rb"))
  local bytes = file:read(limit + 1)
  file:close()
  if bytes and #bytes <= limit then return bytes end
end

function transaction.capture(model)
  local bytes = withTemporaryFile(function(path)
    assert(model.doc:save(path, "xml"))
    return readSnapshot(path)
  end)
  if bytes then return { document = model.doc, filename = model.file_name, bytes = bytes } end
end

local function matches(model, baseline)
  if model.doc ~= baseline.document or model.file_name ~= baseline.filename then return false end
  local current = transaction.capture(model)
  return current ~= nil and current.bytes == baseline.bytes
end

local function loadCandidate(bytes)
  if type(bytes) ~= "string" or #bytes == 0 or #bytes > limit then return end
  return withTemporaryFile(function(path)
    local file = assert(io.open(path, "wb"))
    local written = file:write(bytes)
    local closed = file:close()
    if written and closed then return ipe.Document(path) end
  end)
end

local function replaceDocument(model, candidate)
  local before = model.doc
  local page, view = model.pno, model.vno
  local nextPage = math.min(page, #candidate)
  local nextView = math.min(view, candidate[nextPage]:countViews())
  local edit = {
    label = "Apply reviewed Ipe MCP proposal",
    pno0 = page, vno0 = view, pno1 = nextPage, vno1 = nextView,
    style_sheets_changed = true,
  }
  edit.undo = function()
    model.doc, model.pno, model.vno = before, page, view
  end
  edit.redo = function()
    model.doc, model.pno, model.vno = candidate, nextPage, nextView
  end
  model:register(edit)
end

-- Returns a one-shot review of a parsed, private candidate. The broker supplies
-- a source-identity guard and the caller supplies the GUI confirmation.
function transaction.stage(model, baseline, bytes, checkSource)
  local function unchanged()
    if not matches(model, baseline) then return false end
    local ok, sameSource = pcall(checkSource)
    return ok and sameSource == true
  end
  if not unchanged() then return nil, "conflict" end
  local candidate = loadCandidate(bytes)
  if not candidate or #candidate == 0 then return nil, "invalid-candidate" end
  local reviewed = false
  local summary = { previousPages = #model.doc, proposedPages = #candidate }
  local function review(confirm)
    if reviewed then return "already-reviewed" end
    reviewed = true
    if not unchanged() then return "conflict" end
    if confirm(summary) ~= true then return "declined" end
    if not unchanged() then return "conflict" end
    replaceDocument(model, candidate)
    return "applied"
  end
  return review, summary
end

return transaction
