if #argv ~= 1 then
  io.stderr:write("usage: ipescript check-style FILE.ipe\n")
  os.exit(1)
end
local path = argv[1]
local document = assert(ipe.Document(path))
local undefined = document:checkStyle()
if #undefined > 0 then
  io.stderr:write("undefined styles: " .. table.concat(undefined, ", ") .. "\n")
  os.exit(1)
end
print("IPE_M4_CHECK_STYLE=PASS")
