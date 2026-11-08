-- Install as an Ipe ipelet. Load the helper library from the private installation directory.
local global = _G
local io, os, type, tonumber = global.io, global.os, global.type, global.tonumber
local transaction = global.dofile(assert(os.getenv("IPE_MCP_BRIDGE_TRANSACTION")))
local helper = assert(os.getenv("IPE_MCP_BRIDGE_PEER"))
local windows = global.setmetatable({}, { __mode = "k" })
local limit = 16 * 1024 * 1024 + 512

local function quote(value)
  return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function peer(model, action, state, ...)
  assert(type(model.file_name) == "string" and model.file_name ~= "")
  local command = { "node", quote(helper), quote(action), quote(state.epoch), quote(state.sequence), quote(model.file_name) }
  for i = 1, global.select("#", ...) do command[#command + 1] = quote(global.select(i, ...)) end
  local pipe = assert(io.popen(table.concat(command, " "), "r"))
  local response = pipe:read(limit + 1)
  local ok = pipe:close()
  if ok and response and #response <= limit then return response end
end

local function withSnapshot(snapshot, operation)
  local temporary = os.tmpname()
  local ok, result = global.pcall(function()
    local file = assert(io.open(temporary, "wb"))
    local written = file:write(snapshot.bytes)
    local closed = file:close()
    assert(written and closed)
    return operation(temporary)
  end)
  os.remove(temporary)
  if ok then return result end
end

local function currentSnapshot(model)
  return assert(transaction.capture(model))
end

local function processId()
  local file = assert(io.open("/proc/self/stat", "r"))
  local line = file:read("*l")
  file:close()
  return assert(line:match("^([1-9][0-9]*) "))
end

local function bind(model, state)
  state.documents = global.setmetatable({ [model.doc] = true }, { __mode = "k" })
  state.filename = model.file_name
  windows[model] = state
end

local function attached(model)
  local state = assert(windows[model])
  assert(state.filename == model.file_name and state.documents[model.doc])
  return state
end

local function advance(model, state)
  if state.awaiting then
    assert(peer(model, "receipt", state))
    state.sequence = state.sequence + 1
    state.awaiting = false
  end
  return state
end

local function send(model, state)
  assert(withSnapshot(currentSnapshot(model), function(file)
    return peer(model, "snapshot", state, file)
  end))
  state.awaiting = true
  model.ui:explain("Ipe MCP snapshot sent. Acknowledge sequence " .. state.sequence .. " in MCP.")
end

local function finish(model, state, disposition, action)
  assert(withSnapshot(currentSnapshot(model), function(file)
    return peer(model, action or "finish", state, file, disposition, processId())
  end))
  state.pending, state.outcome = nil, nil
  state.awaiting = true
  model.ui:explain("Ipe MCP outcome sent. Settle sequence " .. state.sequence .. " in MCP.")
end

local function ask(model, text, detail)
  return global.messageBox(model.ui:win(), "question", text, detail, "yesno") == 1
end

local actions = {}

actions[1] = function(model)
  local epoch = model:getString("Enter the Ipe MCP attachment ID", "Attach this Ipe document")
  if not epoch then return end
  assert(#epoch == 32 and epoch:match("^[a-f0-9]+$"))
  local state = { epoch = epoch, sequence = 0 }
  send(model, state)
  bind(model, state)
end

actions[2] = function(model)
  local state = advance(model, attached(model))
  assert(not state.pending and not state.outcome)
  send(model, state)
end

actions[3] = function(model)
  local state = advance(model, attached(model))
  assert(not state.pending and not state.outcome)
  local baseline = currentSnapshot(model)
  local staged = assert(withSnapshot(baseline, function(file) return peer(model, "offer", state, file) end))
  local base, target, hash, body = staged:match("^([0-9]+) ([0-9]+) ([a-f0-9]+)\n(.*)$")
  assert(base and #hash == 64)
  local review, summary = transaction.stage(model, baseline, body, function()
    return peer(model, "check", state) ~= nil
  end)
  assert(review)
  local details = string.format(
    "Replace the open working copy with MCP revision %s (previous common revision %s).\nPages: %d → %d.\nProposal SHA-256: %s\nThe source file will not be saved.",
    target, base, summary.previousPages, summary.proposedPages, hash)
  local approved = ask(model, "Approve this Ipe MCP proposal?", details)
  assert(peer(model, "decision", state, approved and "approved" or "declined", hash))
  if approved then
    state.pending = { review = review, hash = hash }
    model.ui:explain("Ipe MCP approval sent. Authorize sequence " .. state.sequence .. " in MCP.")
  else
    state.outcome = { disposition = "unchanged" }
    finish(model, state, "unchanged")
  end
end

actions[4] = function(model)
  local state = attached(model)
  if state.outcome then return finish(model, state, state.outcome.disposition) end
  local pending = assert(state.pending)
  assert(peer(model, "ready", state))
  local result = pending.review(function()
    return peer(model, "claim", state, pending.hash, processId()) ~= nil
  end)
  assert(result == "applied")
  state.documents[model.doc] = true
  state.outcome = { disposition = "applied" }
  finish(model, state, "applied")
end

actions[5] = function(model)
  local ticket = model:getString("Enter attachment ID, sequence, and applied or unchanged", "Recover Ipe MCP outcome")
  if not ticket then return end
  local epoch, sequence, disposition = ticket:match("^([a-f0-9]+) ([0-9]+) ([a-z]+)$")
  assert(epoch and #epoch == 32 and #sequence <= 10 and (disposition == "applied" or disposition == "unchanged"))
  if not ask(model, "Submit this open document as the recovery outcome?", "This action does not apply a proposal.") then return end
  local state = { epoch = epoch, sequence = tonumber(sequence) }
  finish(model, state, disposition, "recover")
  windows[model] = nil
end

label = "Ipe MCP live bridge"
methods = {
  { label = "Attach this document" },
  { label = "Send working copy" },
  { label = "Review MCP proposal" },
  { label = "Apply approved proposal" },
  { label = "Recover pending outcome" },
}

function run(model, method)
  local ok = global.pcall(actions[method], model)
  if not ok then model:warning("Ipe MCP bridge could not complete this action.",
    "Check the attachment, the working revision and any pending receipt in MCP.") end
end
