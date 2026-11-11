-- Test-only driver for the production ipelet in a real Ipe event loop.
local G = _G
local createModel = G.MODEL.new
local directory = G.os.getenv("IPE_BRIDGE_TEST_CONTROL")
local modelName = "ipe-mcp-live"

local function reply(sequence, value)
  local file = assert(G.io.open(directory .. "/reply.tmp", "wb"))
  file:write(sequence .. " " .. value)
  file:close()
  assert(G.os.rename(directory .. "/reply.tmp", directory .. "/reply"))
end

G.MODEL.new = function(class, filename)
  local model = createModel(class, filename)
  local last, answer, ticket, warned = "", nil, nil, false
  model.getString = function() return ticket end
  model.warning = function() warned = true end
  G.messageBox = function(_, kind)
    if kind ~= "question" then warned = true; return 0 end
    assert(answer ~= nil)
    return answer and 1 or 0
  end
  model.bridge_test_tick = function(self)
    local stream = G.io.open(directory .. "/request", "rb")
    if not stream then return end
    local line = stream:read("*a")
    stream:close()
    local sequence, action, value = line:match("^([0-9]+) ([a-z]+) (.*)$")
    if not sequence or sequence == last then return end
    last, answer, ticket, warned = sequence, value == "yes" or action == "recover", value, false
    local ok = G.pcall(function()
      if action == "edit" then
        local before, after = self.doc:properties(), self.doc:properties()
        after.title = value
        local change = { label = "Test operator edit", pno = self.pno, vno = self.vno }
        change.undo = function(_, doc) doc:setProperties(before) end
        change.redo = function(_, doc) doc:setProperties(after) end
        self:register(change)
      elseif action == "undo" then self:action_undo()
      elseif action == "redo" then self:action_redo()
      elseif action == "verify" then assert(self.doc:properties().title == value)
      else
        local actions = { attach = 1, send = 2, review = 3, apply = 4, recover = 5 }
        self:action_ipelet("ipelet_" .. assert(actions[action]) .. "_" .. modelName)
      end
    end)
    reply(sequence, not ok and "ERROR" or warned and "WARNING" or "OK")
  end
  model.bridge_test_timer = ipeui.Timer(model, "bridge_test_tick")
  model.bridge_test_timer:setInterval(25)
  model.bridge_test_timer:start()
  reply("0", "READY")
  return model
end

label = "Ipe bridge gate driver"
run = function() end
