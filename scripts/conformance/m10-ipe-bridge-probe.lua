-- Test driver only. No production ipelet hooks MODEL.new.
local createModel = _G.MODEL.new
local liveTitle = "Live probe"
local diskTitle = "Disk probe"
local snapshotPath = _G.os.getenv("IPE_BRIDGE_PROBE_SNAPSHOT")
local continuePath = _G.os.getenv("IPE_BRIDGE_PROBE_CONTINUE")

label = "Ipe MCP bridge spike driver"

function run(model)
  local filename = model.file_name
  assert(model:isModified() and model.doc:save(snapshotPath, "xml"))
  assert(model:isModified() and model.file_name == filename)
end

local function record(outcome)
  _G.io.stderr:write("IPE_BRIDGE_PROBE: " .. outcome .. "\n")
  _G.io.stderr:flush()
end

_G.MODEL.new = function(class, filename)
  local model = createModel(class, filename)
  local initialTitle = model.doc:properties().title
  local snapshotted = false

  model.ipe_mcp_bridge_probe_tick = function(self)
    if not snapshotted then
      assert(#self.doc == 1 and not self:isModified())
      local before, after = self.doc:properties(), self.doc:properties()
      after.title = liveTitle
      local edit = { label = "Probe change", pno = self.pno, vno = self.vno, original = before, final = after }
      edit.undo = function(t, doc) doc:setProperties(t.original) end
      edit.redo = function(t, doc) doc:setProperties(t.final) end
      self:register(edit)
      assert(self:isModified())
      assert(not ipe.fileExists(snapshotPath))
      -- The fixture schedules the same dispatch used by Ipe's ipelet menu.
      self:action_ipelet("ipelet_1_bridge-probe")
      assert(ipe.fileExists(snapshotPath))
      snapshotted = true
      record("DIRTY_SNAPSHOT_PASS")
    elseif ipe.fileExists(continuePath) then
      assert(ipe.Document(filename):properties().title == diskTitle)
      assert(self.doc:properties().title == liveTitle and self:isModified())
      self:action_undo()
      assert(self.doc:properties().title == initialTitle)
      assert(ipe.Document(filename):properties().title == diskTitle)
      self.ipe_mcp_bridge_probe_timer:stop()
      record("DISK_CONFLICT_AND_UNDO_PASS")
    end
  end

  model.ipe_mcp_bridge_probe_timer = ipeui.Timer(model, "ipe_mcp_bridge_probe_tick")
  model.ipe_mcp_bridge_probe_timer:setInterval(30)
  model.ipe_mcp_bridge_probe_timer:start()
  return model
end
