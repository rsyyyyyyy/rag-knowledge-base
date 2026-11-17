"""Build a page-aware PDF outline from section headings found at ingestion time.

PDF bookmarks are frequently missing from academic papers. The parser already
records ``section_heading`` and ``page_index`` for every indexed chunk, so that
data can provide the same navigation without re-reading the PDF.
"""
import re
from difflib import SequenceMatcher


KNOWN_SECTIONS = (
    (re.compile(r"^abstract\b", re.IGNORECASE), "Abstract"),
    (re.compile(r"^introduction\b", re.IGNORECASE), "Introduction"),
    (re.compile(r"^related\s+work\b", re.IGNORECASE), "Related Work"),
    (re.compile(r"^background\b", re.IGNORECASE), "Background"),
    (re.compile(r"^preliminar", re.IGNORECASE), "Preliminaries"),
    (re.compile(r"^methods?\b|^methodology\b", re.IGNORECASE), "Method"),
    (re.compile(r"^approach\b", re.IGNORECASE), "Approach"),
    (re.compile(r"^experiments?\b|^experimental\b", re.IGNORECASE), "Experiments"),
    (re.compile(r"^evaluation\b", re.IGNORECASE), "Evaluation"),
    (re.compile(r"^results?\b", re.IGNORECASE), "Results"),
    (re.compile(r"^discussion\b", re.IGNORECASE), "Discussion"),
    (re.compile(r"^conclusions?\b", re.IGNORECASE), "Conclusion"),
    (re.compile(r"^references?\b", re.IGNORECASE), "References"),
    (re.compile(r"^acknowledg", re.IGNORECASE), "Acknowledgements"),
    (re.compile(r"^appendi", re.IGNORECASE), "Appendix"),
    (re.compile(r"^limitations?\b", re.IGNORECASE), "Limitations"),
    (re.compile(r"^future\s+work\b", re.IGNORECASE), "Future Work"),
    (re.compile(r"^摘\s*要"), "摘要"),
    (re.compile(r"^(引\s*言|绪\s*论)"), "引言"),
    (re.compile(r"^相关工作"), "相关工作"),
    (re.compile(r"^研究背景"), "研究背景"),
    (re.compile(r"^方\s*法"), "方法"),
    (re.compile(r"^实\s*验"), "实验"),
    (re.compile(r"^结\s*果"), "结果"),
    (re.compile(r"^讨\s*论"), "讨论"),
    (re.compile(r"^结\s*论"), "结论"),
    (re.compile(r"^参考文献"), "参考文献"),
    (re.compile(r"^致\s*谢"), "致谢"),
    (re.compile(r"^附\s*录"), "附录"),
)
NUMBERED = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s*(.+)$")
CHAPTER = re.compile(r"^(第[一二三四五六七八九十百]+[章节篇])\s*(.*)$")
CHINESE_NUMBERED = re.compile(r"^([一二三四五六七八九十]+)[、.]\s*(.+)$")
SECOND_NUMBER = re.compile(r"\s+(?=\d{1,2}(?:\.\d{1,2})+\s+[A-Z])")
ARXIV = re.compile(r"arxiv|vixra|\b\d{4}\.\d{4,5}\b", re.IGNORECASE)
AUTHOR_LIST = re.compile(r"\S+,\S+,\S+")
CJK_OR_LETTER = re.compile(r"[A-Za-z㐀-鿿]")
UPPER_OR_CJK = re.compile(r"^[A-Z㐀-鿿]")
FILENAME_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,6}$")
SENTENCE_SPLIT = re.compile(r"\.\s+")
NUMBER_TOKENS = re.compile(r"(?:^|\s)\d{1,2}\s+[A-Z]")


def _clean(value):
    return re.sub(r"\s+", " ", value or "").strip()


def _key(value):
    return re.sub(r"[^\w㐀-鿿]+", " ", (value or "").lower()).strip()


def _canonical(title):
    cleaned = _clean(title)
    for pattern, name in KNOWN_SECTIONS:
        if pattern.match(cleaned):
            return name
    return ""


def _trim_title(title):
    """Drop a sentence that the parser merged into an over-long heading."""
    if len(title) <= 70:
        return title
    parts = SENTENCE_SPLIT.split(title)
    head = parts[0].strip().rstrip(".")
    if re.search(r"[A-Za-z㐀-鿿]{2,}", head):
        return head if len(head) <= 120 else head[:120]
    if len(parts) > 1:
        combined = f"{head} {parts[1]}".strip().rstrip(".")
        return combined if len(combined) <= 120 else combined[:120]
    return title[:120]


def _same_document_title(title, document_title):
    if not document_title:
        return False
    left, right = _key(title), _key(document_title)
    if not left or not right:
        return False
    return left == right or SequenceMatcher(None, left, right).ratio() >= 0.9


def parse_heading(value, document_title=""):
    """Return ``(title, level)`` for a plausible section heading, else None."""
    title = _clean(value)
    if not title or len(title) > 160 or not CJK_OR_LETTER.search(title):
        return None
    if ARXIV.search(title) or AUTHOR_LIST.search(title):
        return None
    if any(mark in title for mark in "*†‡"):
        return None

    # Side-by-side columns can merge two numbered headings into one line.
    title = SECOND_NUMBER.split(title)[0].strip()
    if not title:
        return None

    match = NUMBERED.match(title)
    if match:
        number, body = match.group(1), match.group(2).strip()
        if len(body) < 2 or not UPPER_OR_CJK.match(body):
            return None
        candidate = f"{number} {body}"
        level = min(number.count(".") + 1, 4)
    else:
        match = CHAPTER.match(title)
        if match:
            number, body = match.group(1), match.group(2).strip()
            candidate = f"{number} {body}".strip()
            level = 1
        else:
            match = CHINESE_NUMBERED.match(title)
            if match:
                number, body = match.group(1), match.group(2).strip()
                candidate = f"{number}、{body}"
                level = 1
            else:
                canonical = _canonical(title)
                if not canonical:
                    return None
                candidate = canonical
                level = 1

    candidate = _trim_title(candidate)
    if not candidate or len(NUMBER_TOKENS.findall(candidate)) > 1:
        return None
    if _same_document_title(candidate, document_title):
        return None
    return candidate, level


def build_outline(rows, document_title=""):
    """Convert ordered ``(heading, page_index, chunk_index)`` rows to an outline."""
    document_title = FILENAME_EXTENSION.sub("", _clean(document_title))
    outline, seen = [], set()
    for heading, page_index, _ in rows:
        parsed = parse_heading(heading, document_title)
        if not parsed:
            continue
        title, level = parsed
        key = _key(title)
        if not key or key in seen:
            continue
        seen.add(key)
        try:
            page = int(page_index)
        except (TypeError, ValueError):
            page = 0
        outline.append({"title": title, "level": level, "page_index": max(0, page)})
        if len(outline) >= 80:
            break
    return outline


def outline_for_document(catalog, doc_id, document_title=""):
    with catalog.connect() as db:
        active = db.execute(
            "SELECT generation FROM active_indexes WHERE doc_id = ?", (doc_id,),
        ).fetchone()
        if not active:
            return []
        rows = db.execute("""
            SELECT json_extract(metadata, '$.section_heading'),
                   json_extract(metadata, '$.page_index'),
                   CAST(json_extract(metadata, '$.chunk_index') AS INTEGER)
            FROM indexed_chunks
            WHERE generation = ?
            ORDER BY CAST(json_extract(metadata, '$.chunk_index') AS INTEGER), rowid
        """, (active[0],)).fetchall()
    outline = build_outline(rows, document_title)
    if outline and not any(
        item["title"].lower().startswith(("abstract", "摘要")) for item in outline
    ):
        first = outline[0]
        if re.match(r"^(1\b|1\.|一、|第[一]章|引\s*言|绪\s*论)", first["title"]):
            title = "摘要" if re.search(r"[㐀-鿿]", first["title"]) else "Abstract"
            outline.insert(0, {"title": title, "level": 1, "page_index": first["page_index"]})
    return outline
