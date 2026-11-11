-- Test-only driver. Exercises the transaction inside a real Ipe Qt model.
local createModel = _G.MODEL.new
local bridge = _G.dofile(_G.os.getenv("IPE_BRIDGE_TRANSACTION"))
local sourceGuard = true

local function proposal()
  local path = _G.os.getenv("IPE_BRIDGE_PROPOSAL")
  local file = assert(_G.io.open(path, "rb"))
  local data = file:read("*a")
  file:close()
  return data
end

local function checkSource()
  return sourceGuard
end

local function record()
  _G.io.stderr:write("IPE_BRIDGE_PROBE: REVIEW_APPLY_UNDO_REDO_PASS\n")
  _G.io.stderr:flush()
end

_G.MODEL.new = function(class, filename)
  local model = createModel(class, filename)
  model.ipe_mcp_bridge_transaction_tick = function(self)
    self.ipe_mcp_bridge_transaction_timer:stop()
    local initial = self.doc
    assert(#initial == 2 and initial[1][1]:getCustom() == "ipe-mcp:bridge-probe-object")
    self.pno = 2
    self:setPage()
    local initialUndo = #self.undo
    local baseline = assert(bridge.capture(self))
    local bytes = proposal()
    local review = assert(bridge.stage(self, baseline, bytes, checkSource))
    assert(review(function() return false end) == "declined")
    assert(review(function() return true end) == "already-reviewed")
    assert(#self.undo == initialUndo and self.doc == initial and self.pno == 2)

    review = assert(bridge.stage(self, baseline, bytes, checkSource))
    assert(review(function()
      sourceGuard = false
      return true
    end) == "conflict")
    assert(self.doc == initial and #self.undo == initialUndo)
    sourceGuard = true
    local rejected, reason = bridge.stage(self, baseline, bytes, function() error("source unavailable") end)
    assert(rejected == nil and reason == "conflict")

    review = assert(bridge.stage(self, baseline, bytes, checkSource))
    assert(review(function()
      local before, after = self.doc:properties(), self.doc:properties()
      after.title = "Concurrent live edit"
      local edit = { label = "Concurrent edit", pno = self.pno, vno = self.vno }
      edit.undo = function(_, doc) doc:setProperties(before) end
      edit.redo = function(_, doc) doc:setProperties(after) end
      self:register(edit)
      return true
    end) == "conflict")
    assert(self.doc:properties().title == "Concurrent live edit" and #self.undo == initialUndo + 1)

    baseline = assert(bridge.capture(self))
    review = assert(bridge.stage(self, baseline, bytes, checkSource))
    assert(review(function(summary)
      assert(summary.previousPages == 2 and summary.proposedPages == 1)
      return true
    end) == "applied")
    assert(review(function() return true end) == "already-reviewed")
    assert(self.doc:properties().title == "Reviewed candidate")
    assert(self.doc[1][1]:getCustom() == "ipe-mcp:bridge-probe-object")
    assert(#self.undo == initialUndo + 2 and self.pno == 1 and self:isModified())
    assert(self.file_name == filename)
    self:action_undo()
    assert(self.doc == initial and self.pno == 2 and self.doc:properties().title == "Concurrent live edit")
    self:action_redo()
    assert(self.doc[1][1]:getCustom() == "ipe-mcp:bridge-probe-object" and self.pno == 1)
    assert(self.file_name == filename)
    record()
  end
  model.ipe_mcp_bridge_transaction_timer = ipeui.Timer(model, "ipe_mcp_bridge_transaction_tick")
  model.ipe_mcp_bridge_transaction_timer:setInterval(20)
  model.ipe_mcp_bridge_transaction_timer:start()
  return model
end

label = "Ipe MCP bridge transaction probe"
run = function() end
