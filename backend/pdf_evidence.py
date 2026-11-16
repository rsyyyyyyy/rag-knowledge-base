import hashlib
import json
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


def reading_blocks(chars, box):
    """Split obvious two-column runs around a persistent empty center gutter."""
    left, _, right, _ = box
    width = right - left
    center = (left + right) / 2
    rows = cluster_objects(chars, "top", tolerance=3)
    first, second, full = [], [], []
    gap = width * 0.012
    classified = []
    for row in rows:
        lhs = [char for char in row if char["x1"] <= center - gap]
        rhs = [char for char in row if char["x0"] >= center + gap]
        spans_gutter = any(
            char["text"].strip() and char["x1"] > center - gap and char["x0"] < center + gap
            for char in row
        )
        classified.append((row, lhs, rhs, spans_gutter))
    paired_rows = 0
    for _, lhs, rhs, spans_gutter in classified:
        if spans_gutter:
            paired_rows = 0
        else:
            paired_rows += int(bool(lhs) and bool(rhs))
            if paired_rows >= 3:
                break
    else:
        yield chars
        return

    paired_rows = 0
    for row, lhs, rhs, spans_gutter in classified:
        if spans_gutter:
            if paired_rows >= 3:
                yield first
                yield second
            elif full:
                yield full
            yield row
            first, second, full = [], [], []
            paired_rows = 0
        else:
            first.extend(lhs)
            second.extend(rhs)
            full.extend(row)
            paired_rows += int(bool(lhs) and bool(rhs))
    if paired_rows >= 3:
        yield first
        yield second
    elif full:
        yield full


def extract_pdf_chunks(path: Path, chunk_size: int = 500):
    """Yield page-local text and normalized rectangles in PDF display orientation."""
    with pdfplumber.open(path) as pdf:
        for page_index, page in enumerate(pdf.pages):
            try:
                left, top, right, bottom = page.bbox
                crop_left, crop_top, crop_right, crop_bottom = page.cropbox
                box = (
                    max(left, crop_left), max(top, crop_top),
                    min(right, crop_right), min(bottom, crop_bottom),
                )
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue

                chars, read_box, turns = reading_chars(page.crop(box), box)
                left, top, right, bottom = read_box
                width, height = right - left, bottom - top
                if not chars:
                    continue
                for block in reading_blocks(chars, read_box):
                    lines = chars_to_textmap(block).extract_text_lines(strip=True, return_chars=False)
                    texts, rects = [], []
                    length = 0
                    for line in lines:
                        line_text = line["text"].strip()
                        if not line_text:
                            continue
                        if texts and length + len(line_text) + 1 > chunk_size:
                            yield "\n".join(texts), {
                                "page_index": page_index, "rects_json": json.dumps(rects),
                            }
                            texts, rects = [], []
                            length = 0

                        rects.append(rotate_box((
                            (line["x0"] - left) / width, (line["top"] - top) / height,
                            (line["x1"] - left) / width, (line["bottom"] - top) / height,
                        ), turns))
                        texts.append(line_text)
                        length += len(line_text) + 1
                    if texts:
                        yield "\n".join(texts), {
                            "page_index": page_index, "rects_json": json.dumps(rects),
                        }
            finally:
                page.close()
