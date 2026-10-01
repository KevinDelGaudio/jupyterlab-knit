/**
 * Lua filter written next to a notebook the first time it is knitted to PDF
 * with a header that references it. Canonical copy of wide-tables.lua.
 */
export const WIDE_TABLES_FILE = 'wide-tables.lua';

export const WIDE_TABLES_LUA = String.raw`--[[
wide-tables.lua: keep wide tables inside the page in PDF output.

Pandoc typesets tables without column widths as plain "l" columns, which never
wrap, so a table wider than the text block runs off the page. For such a
table this filter picks the largest font size at which it fits with headers
wrapped between words, sets the column widths accordingly and disables
hyphenation inside it. Tables that already fit are left untouched.

Widths are estimated from character counts, assuming a text block about
440pt wide (Quarto's default PDF layout) and an average glyph width of
0.58em, which errs on the wide side. Font sizes are set in absolute points
so the estimate does not depend on the document's base size.
]]

local TEXT_WIDTH_PT = 440
local GLYPH_EM = 0.58
local BODY_PT = 11          -- Quarto's default document font size
local MAX_CELL_CHARS = 30   -- longer body cells are allowed to wrap

local SIZES = { 10, 9, 8, 7, 6 }

local function size_command(pt)
  return string.format("\\fontsize{%dpt}{%.1fpt}\\selectfont", pt, pt * 1.2)
end

local function chars(text)
  return utf8.len(text) or #text
end

local function longest_word(text)
  local best = 0
  for word in text:gmatch("%S+") do
    best = math.max(best, chars(word))
  end
  return best
end

-- per column: width as typeset now (headers on one line) and the width
-- needed when headers wrap between words
local function measure(tbl, n)
  local unwrapped, wrapped = {}, {}
  for i = 1, n do
    unwrapped[i], wrapped[i] = 1, 1
  end

  local function scan(rows, is_head)
    for _, row in ipairs(rows) do
      local col = 1
      for _, cell in ipairs(row.cells) do
        if col <= n then
          local text = pandoc.utils.stringify(cell.contents)
          unwrapped[col] = math.max(unwrapped[col], chars(text))
          local need = longest_word(text)
          if not is_head then
            need = math.max(need, math.min(chars(text), MAX_CELL_CHARS))
          end
          wrapped[col] = math.max(wrapped[col], need)
        end
        col = col + (cell.col_span or 1)
      end
    end
  end

  scan(tbl.head.rows, true)
  for _, body in ipairs(tbl.bodies) do
    scan(body.head, true)
    scan(body.body, false)
  end
  return unwrapped, wrapped
end

local function sum(values)
  local total = 0
  for _, v in ipairs(values) do total = total + v end
  return total
end

function Table(tbl)
  if not FORMAT:match("latex") then
    return nil
  end
  local n = #tbl.colspecs
  if n == 0 then
    return nil
  end

  local unwrapped, wrapped = measure(tbl, n)

  -- as pandoc would typeset it: normal size, 6pt padding on each side
  if sum(unwrapped) * GLYPH_EM * BODY_PT + n * 12 <= TEXT_WIDTH_PT then
    return nil
  end

  -- inside the group padding is 2pt on each side
  local available = TEXT_WIDTH_PT - n * 4
  local needed = sum(wrapped)
  local chosen = nil
  for _, pt in ipairs(SIZES) do
    if needed * GLYPH_EM * pt <= available then
      chosen = pt
      break
    end
  end

  local hyphenation = "\\hyphenpenalty=10000\\exhyphenpenalty=10000"
  local glyph
  if chosen then
    glyph = GLYPH_EM * chosen
  else
    -- too wide even at the smallest size: squeeze and let words hyphenate
    chosen = SIZES[#SIZES]
    glyph = available / needed
    hyphenation = ""
  end

  for i = 1, n do
    tbl.colspecs[i] = { tbl.colspecs[i][1], wrapped[i] * glyph / available }
  end

  return {
    pandoc.RawBlock("latex", "\\begingroup" .. size_command(chosen) ..
      "\\setlength{\\tabcolsep}{2pt}" .. hyphenation),
    tbl,
    pandoc.RawBlock("latex", "\\endgroup"),
  }
end
`;
