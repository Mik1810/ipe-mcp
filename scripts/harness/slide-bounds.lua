-- A native Ipe PDF embeds the editable source and compiled TeX metrics.
-- Emit only numeric paper/geometry data, with one-based page/view/object indices.
local document = assert(ipe.Document(argv[1]))
local sheets = document:sheets()
local layout = assert(sheets:find("layout"))
print(-layout.origin.x, -layout.origin.y, layout.papersize.x, layout.papersize.y)

for slide = 1, #document do
  local page = document[slide]
  for view = 1, page:countViews() do
    print("view", slide, view)
    local matrices = page:layerMatrices(view)
    for index, object, _, layer in page:objects() do
      if page:visible(view, index) then
        local box = ipe.Rect()
        object:addToBBox(box, matrices[layer] or ipe.Matrix(), false)
        assert(not box:isEmpty())
        local padding = 0
        if object:type() == "path" and object:get("stroke") ~= "undefined" then
          local pen = object:get("pen")
          padding = (tonumber(pen) or sheets:find("pen", pen) or 0) / 2
        end
        local low, high = box:bottomLeft(), box:topRight()
        print("box", index, low.x - padding, low.y - padding, high.x + padding, high.y + padding)
      end
    end
  end
end
