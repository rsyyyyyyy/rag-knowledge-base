import hashlib
import json
import re
import unicodedata
from functools import lru_cache
from statistics import median

import tiktoken
from collections import Counter
from math import atan2, degrees
from pathlib import Path

import pdfplumber
from pdfplumber.utils import chars_to_textmap, cluster_objects


def pdf_version(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def rotate_point(x, y, turns):
    """Rotate normalized page coordinates clockwise in quarter turns."""
    for _ in range(turns % 4):
        x, y = 1 - y, x
    return x, y


def rotate_box(box, turns):
    left, top, right, bottom = box
    x0, y0 = rotate_point(left, top, turns)
    x1, y1 = rotate_point(right, bottom, turns)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def reading_chars(page, box):
    """Put page-rotated horizontal text back in reading order for line extraction."""
    chars = page.dedupe_chars().chars
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    turns = page.rotation // 90
    if turns and chars:
        orientations = Counter(
            round(-degrees(atan2(char["matrix"][1], char["matrix"][0])) / 90) % 4
            for char in chars if char["text"].strip()
        )
        if orientations and orientations.most_common(1)[0][0] == turns:
            read_width, read_height = (height, width) if turns % 2 else (width, height)
            positioned = []
            for char in chars:
                x0, y0, x1, y1 = rotate_box((
                    (char["x0"] - left) / width, (char["top"] - top) / height,
                    (char["x1"] - left) / width, (char["bottom"] - top) / height,
                ), -turns)
                positioned.append({
                    **char, "upright": True, "x0": x0 * read_width, "top": y0 * read_height,
                    "x1": x1 * read_width, "bottom": y1 * read_height,
                    "width": (x1 - x0) * read_width, "height": (y1 - y0) * read_height,
                })
            return positioned, (0, 0, read_width, read_height), turns
    return chars, box, 0


PARSER_VERSION = "paragraph-spans-v3"


@lru_cache(maxsize=1)
def tokenizer():
    return tiktoken.get_encoding("cl100k_base")


def token_count(text):
    return len(tokenizer().encode(text, disallowed_special=()))


def reading_blocks(chars, box):
    """Infer a real column gutter from repeated whitespace, not a fixed center band."""
    left, _, right, _ = box
    width = right - left
    rows = cluster_objects(chars, "top", tolerance=3)
    candidates = []
    for row in rows:
        glyphs = sorted((c for c in row if c["text"].strip()), key=lambda c: c["x0"])
        for lhs, rhs in zip(glyphs, glyphs[1:]):
            middle = (lhs["x1"] + rhs["x0"]) / 2
            if (left + width * .35 < middle < left + width * .65
                    and rhs["x0"] - lhs["x1"] > max(10, lhs["size"] * 1.2)):
                candidates.append(middle)
    if len(candidates) < 3:
        yield chars
        return
    cut = median(candidates)
    first, second, spanning = [], [], []
    for row in rows:
        visible = [c for c in row if c["text"].strip()]
        lhs = [c for c in row if (c["x0"] + c["x1"]) / 2 < cut]
        rhs = [c for c in row if (c["x0"] + c["x1"]) / 2 >= cut]
        lv, rv = [c for c in lhs if c["text"].strip()], [c for c in rhs if c["text"].strip()]
        gap = min(c["x0"] for c in rv) - max(c["x1"] for c in lv) if lv and rv else float("inf")
        across = bool(lv and rv and gap < max(10, median(c["size"] for c in visible) * 1.2))
        if across:
            if first: yield first
            if second: yield second
            first, second = [], []
            spanning.extend(row)
        else:
            if spanning: yield spanning
            spanning = []
            first.extend(lhs)
            second.extend(rhs)
    if spanning: yield spanning
    if first: yield first
    if second: yield second


def _heading(line, body_size):
    text = line["text"].strip()
    size = median(c["size"] for c in line["chars"]) if line["chars"] else body_size
    return len(text) < 180 and (size > body_size * 1.15 or (
        len(text.split()) <= 12 and not re.search(r'[。.!?;；,-]$', text) and bool(re.match(
        r"^(?:[1-9]\d?(?:\.\d{1,2}){0,3}[.\s]+[A-Z\u4e00-\u9fff]|abstract\b|introduction\b|conclusions?\b|references\b|摘要|引言|结论|参考文献)", text, re.I))))


def _line_map(line, text, box, turns):
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    def rect(chars):
        return rotate_box(((min(c["x0"] for c in chars)-left)/width,
                           (min(c["top"] for c in chars)-top)/height,
                           (max(c["x1"] for c in chars)-left)/width,
                           (max(c["bottom"] for c in chars)-top)/height), turns)
    text_units = [(unit, index) for index, value in enumerate(text)
                  for unit in unicodedata.normalize("NFKC", value) if not unit.isspace()]
    glyph_units = [(unit, index) for index, char in enumerate(sorted(line["chars"], key=lambda c: c["x0"]))
                   for unit in unicodedata.normalize("NFKC", char["text"]) if not unit.isspace()]
    characters = sorted(line["chars"], key=lambda c: c["x0"])
    words = []
    # Only a lossless glyph/text alignment is eligible for precise word boxes.
    # Ligatures expand through NFKC; other mismatches degrade honestly to a line.
    if ''.join(u for u, _ in text_units) == ''.join(u for u, _ in glyph_units):
        aligned = [(offset, glyph_index) for (_, offset), (_, glyph_index) in zip(text_units, glyph_units)]
        for match in re.finditer(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*|[\u4e00-\u9fff]|[^\s]", text):
            indices = {index for offset, index in aligned if match.start() <= offset < match.end()}
            if indices:
                words.append({"start": match.start(), "end": match.end(),
                              "rect": rect([characters[i] for i in sorted(indices)]), "mapped": True})
    return {"rect": rect(line["chars"]), "words": words}


def _segments(text, budget):
    """Split a long element at sentence/word boundaries, preserving exact offsets."""
    start = 0
    while start < len(text):
        end = len(text)
        if token_count(text[start:]) > budget:
            low, high = start + 1, len(text)
            while low < high:
                middle = (low + high + 1) // 2
                if token_count(text[start:middle]) <= budget: low = middle
                else: high = middle - 1
            end = low
            boundaries = list(re.finditer(r"[。！？.!?;；]\s*|\s+", text[start:end]))
            usable = [start + m.end() for m in boundaries if m.end() > (end-start) // 2]
            if usable: end = usable[-1]
        yield start, end
        start = end


def extract_pdf_chunks(path: Path, chunk_size: int = 384):
    """Paragraph reading chunks with token budgets and immutable element/word provenance.

    chunk_size is a token budget in cl100k_base, not a provider billing count.
    Each output is page-local. Source mappings remain on exact extracted text.
    """
    section = ""
    font_counts = Counter()
    with pdfplumber.open(path) as pdf:
        for page_index, page in enumerate(pdf.pages):
            try:
                left, top, right, bottom = page.bbox
                cl, ct, cr, cb = page.cropbox
                box = (max(left, cl), max(top, ct), min(right, cr), min(bottom, cb))
                if box[2] <= box[0] or box[3] <= box[1]: continue
                chars, read_box, turns = reading_chars(page.crop(box), box)
                if not chars: continue
                font_counts.update(round(c['size'], 1) for c in chars if c['text'].strip())
                body_size = font_counts.most_common(1)[0][0]
                tables = page.find_tables() if not turns else []
                elements = []
                for block_index, block in enumerate(reading_blocks(chars, read_box)):
                    lines = chars_to_textmap(block).extract_text_lines(strip=True, return_chars=True)
                    current, kind, table_index = [], "paragraph", None
                    def flush():
                        if current:
                            elements.append({"id": f"p{page_index+1}:b{block_index}:e{len(elements)}",
                                             "kind": kind, "heading": section, "lines": list(current)})
                            current.clear()
                    previous = None
                    for line in lines:
                        text = line["text"].strip()
                        if not text: continue
                        line["text"] = text
                        table = next((i for i, t in enumerate(tables) if
                            t.bbox[0] <= (line["x0"]+line["x1"])/2 <= t.bbox[2] and
                            t.bbox[1] <= (line["top"]+line["bottom"])/2 <= t.bbox[3]), None)
                        new_kind = "table" if table is not None else "heading" if _heading(line, body_size) else "paragraph"
                        paragraph_break = previous and new_kind == "paragraph" and (
                            line["top"] - previous["bottom"] > body_size * .65 or
                            (abs(line["x0"]-previous["x0"]) > body_size * .9 and
                             re.search(r"[。.!?;；]$", previous["text"])))
                        heading_break = new_kind == 'heading' and previous and (
                            line['top']-previous['bottom'] > body_size * .8 or
                            abs(median(c['size'] for c in line['chars']) - median(c['size'] for c in previous['chars'])) > body_size * .15)
                        continued_heading = bool(current and kind == new_kind == 'heading' and not heading_break)
                        if current and (new_kind != kind or table != table_index or paragraph_break or heading_break):
                            flush()
                        if new_kind == "heading": section = section + ' ' + text if continued_heading else text
                        kind, table_index = new_kind, table
                        current.append(line)
                        previous = line
                    flush()
                parts = []
                for element in elements:
                    text = "\n".join(line["text"] for line in element["lines"])
                    line_maps, offset = [], 0
                    for line in element["lines"]:
                        mapping = _line_map(line, line["text"], read_box, turns)
                        mapping.update(start=offset, end=offset+len(line["text"]), element_id=element["id"])
                        for word in mapping["words"]:
                            word["start"] += offset
                            word["end"] += offset
                        line_maps.append(mapping)
                        offset += len(line["text"]) + 1
                    for start, end in _segments(text, chunk_size):
                        parts.append({"text": text[start:end], "element": element,
                                      "element_start": start, "maps": line_maps, "start": start, "end": end})
                batch = []
                def emit(items):
                    content, mappings, refs, offset = [], [], [], 0
                    for item in items:
                        content.append(item["text"])
                        refs.append({"id": item["element"]["id"], "kind": item["element"]["kind"],
                                     "start": offset, "end": offset+len(item["text"]),
                                     "element_start": item["element_start"]})
                        for line in item["maps"]:
                            begin, finish = max(line["start"], item["start"]), min(line["end"], item["end"])
                            if begin >= finish: continue
                            words = [{**w, "start": max(w["start"],begin)-item["start"]+offset,
                                      "end": min(w["end"],finish)-item["start"]+offset}
                                     for w in line["words"] if w["start"] < finish and w["end"] > begin]
                            mappings.append({"start": begin-item["start"]+offset,
                                             "end": finish-item["start"]+offset,
                                             "element_id": line["element_id"], "rect": line["rect"], "words": words})
                        offset += len(item["text"]) + 1
                    text = "\n".join(content)
                    return text, {"page_index": page_index, "parser_version": PARSER_VERSION,
                                  "section_heading": items[0]["element"]["heading"],
                                  "token_count": token_count(text), "elements_json": json.dumps(refs),
                                  "source_map_json": json.dumps(mappings),
                                  "rects_json": json.dumps([m["rect"] for m in mappings]),
                                  "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
                for part in parts:
                    if batch and (batch[-1]["element"]["heading"] != part["element"]["heading"] or
                                  batch[-1]["element"]["kind"] == "table" or part["element"]["kind"] == "table" or
                                  token_count("\n".join([p["text"] for p in batch]+[part["text"]])) > chunk_size):
                        yield emit(batch)
                        batch = []
                    batch.append(part)
                if batch: yield emit(batch)
            finally:
                page.close()
