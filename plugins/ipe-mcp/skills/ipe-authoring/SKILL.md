---
name: ipe-authoring
description: Create or edit Ipe drawings and slide decks, validate them, and export PDF or PNG through the local Ipe MCP server.
---

Start with `ipe_orientation` and `ipe_get_capabilities`. Use the detected capability mode to decide whether native validation and export are available.

Create or open the document and inspect its current revision, page, layer, and view IDs. Use the IDs returned by Ipe MCP and pass the current revision with every mutation. For presentations, compose pages and add views for progressive reveals. Preview the relevant views when native rendering is available.

Use structural validation before saving. For PDF or PNG, validate and export through Ipe MCP, then retrieve the requested resource. Save to the agreed path inside the configured workspace. Honor the server's explicit confirmations for save, delete, undo, and restore. If validation fails, use its diagnostics to correct the document or explain the limitation.
