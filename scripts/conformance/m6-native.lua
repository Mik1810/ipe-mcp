-- Versioned native Ipelib bridge for M6.  Keep stdout machine-readable.
local protocol = "ipe-mcp-native/1"

local function fail(kind)
  io.stderr:write("IPE_M6_ERROR=" .. kind .. "\n")
  os.exit(1)
end

if #argv < 1 then fail("usage") end
local mode = argv[1]

if mode == "version" then
  print("IPE_M6_PROTOCOL=" .. protocol)
  local version = ipe.version
  if not version and ipe.config then
    local configured = ipe.config()
    version = configured and configured.version
  end
  if not version then
    version = package.path:match("ipe/(%d+%.%d+%.%d+)/scripts")
  end
  if not version then
    local maps = io.open("/proc/self/maps", "r")
    if maps then
      local loaded = maps:read("*all")
      maps:close()
      version = loaded:match("libipe%.so%.(%d+%.%d+%.%d+)")
    end
  end
  print("IPE_M6_VERSION=" .. tostring(version))
  os.exit(0)
end

if #argv < 2 then fail("usage") end
local document, load_error = ipe.Document(argv[2])
if not document then fail("load") end

if mode == "check-style" then
  local undefined = document:checkStyle()
  if #undefined > 0 then fail("style") end
elseif mode == "run-latex" then
  if #argv ~= 3 then fail("usage") end
  local success = document:runLatex(argv[2])
  if not success then fail("latex") end
  local saved, save_error = document:save(argv[3], "xml")
  if not saved then fail("save") end
elseif mode == "reload" then
  if #argv ~= 3 then fail("usage") end
  local saved, save_error = document:save(argv[3], "xml")
  if not saved then fail("save") end
else
  fail("usage")
end

print("IPE_M6_PROTOCOL=" .. protocol)
print("IPE_M6_RESULT=PASS")
