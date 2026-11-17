"""Fill bibliographic metadata from the PDF itself and public scholarly APIs.

Automatic enrichment only fills empty fields; anything the user edited is kept.
Network failures are diagnostic-only and never block upload or ingestion.
"""
import logging
import os
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import quote

import httpx


logger = logging.getLogger(__name__)

CROSSREF = "https://api.crossref.org/works"
OPENALEX = "https://api.openalex.org/works"
OPENALEX_FIELDS = (
    "id,title,doi,publication_year,authorships,primary_location,"
    "cited_by_count,abstract_inverted_index"
)
USER_AGENT = "rag-knowledge-base/1.0 (bibliographic metadata enrichment)"
DOI = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)
TRAILING = ".,;:!?)]}>,，。；：！？）】」》"
PLACEHOLDER_TITLES = re.compile(
    r"^(untitled|microsoft word|wps|doc\d*|slide\d*|document\d*|无标题.*)$", re.IGNORECASE
)
PLACEHOLDER_AUTHORS = re.compile(
    r"^(administrator|admin|user|unknown|microsoft|wps|作者|author)$", re.IGNORECASE
)
PLACEHOLDER_DOI = re.compile(r"(?:n{4,}|x{4,}|0{6,})", re.IGNORECASE)


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def _has_value(value):
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict)):
        return bool(value)
    return value is not None


def normalize_doi(value):
    """Accept a bare DOI, a doi: prefix or a doi.org URL; reject anything else."""
    if not isinstance(value, str):
        return ""
    doi = re.sub(
        r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.IGNORECASE
    ).rstrip(TRAILING)
    return doi.lower() if DOI.fullmatch(doi) else ""


def _title_key(value):
    return re.sub(r"[^\w㐀-鿿]+", " ", (value or "").lower()).strip()


def title_similarity(left, right):
    """Compare titles ignoring punctuation, case and whitespace differences."""
    first, second = _title_key(left), _title_key(right)
    if not first or not second:
        return 0.0
    if first == second:
        return 1.0
    return SequenceMatcher(None, first, second).ratio()


def _strip_markup(value):
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", text).strip()


def _abstract_from_inverted(index):
    words = sorted(
        (position, word)
        for word, positions in (index or {}).items()
        for position in (positions or [])
    )
    return " ".join(word for _, word in words)


def _filename_title(filename):
    stem = Path(filename or "").stem
    stem = re.sub(r"[_-]+", " ", stem).strip()
    if len(stem) < 8 or re.fullmatch(r"[0-9a-f]{16,}", stem, re.IGNORECASE):
        return ""
    return stem


def _placeholder_title(value, filename=None):
    title = _text(value)
    if not title or PLACEHOLDER_TITLES.match(title):
        return True
    return bool(filename) and title.lower() in {
        filename.lower(), Path(filename).stem.lower(),
    }


def extract_pdf_metadata(path):
    """Read PDF document info and look for a DOI on the first two pages."""
    result = {}
    if not path:
        return result
    path = Path(path)
    if path.suffix.lower() != ".pdf" or not path.is_file():
        return result
    try:
        import PyPDF2

        reader = PyPDF2.PdfReader(str(path))
        info = reader.metadata or {}
        title = _text(info.get("/Title"))
        author = _text(info.get("/Author"))
        if title and not PLACEHOLDER_TITLES.match(title):
            result["title"] = title
        if author and not PLACEHOLDER_AUTHORS.match(author):
            authors = [
                part.strip() for part in re.split(r"[;；,，、]", author) if part.strip()
            ]
            if authors:
                result["authors"] = authors
        text = "\n".join((page.extract_text() or "") for page in reader.pages[:2])
        match = DOI.search(text)
        if match:
            doi = normalize_doi(match.group(0))
            if doi:
                result["doi"] = doi
    except Exception as error:
        logger.info("PDF metadata extraction skipped for %s: %s", path.name, type(error).__name__)
    return result


def _get_json(url, params=None):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    email = os.getenv("OPENALEX_MAILTO", "").strip()
    if email and url.startswith("https://api.openalex.org"):
        params = {**(params or {}), "mailto": email}
    with httpx.Client(timeout=12, follow_redirects=True, headers=headers) as client:
        response = client.get(url, params=params)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()


def lookup_crossref(doi):
    doi = normalize_doi(doi)
    if not doi:
        return {}
    try:
        data = _get_json(f"{CROSSREF}/{quote(doi, safe='/')}")
    except Exception as error:
        logger.info("Crossref lookup skipped for %s: %s", doi, type(error).__name__)
        return {}
    message = (data or {}).get("message") or {}
    authors = []
    for author in message.get("author") or []:
        name = " ".join(
            part for part in (author.get("given"), author.get("family")) if _text(part)
        ).strip()
        if name:
            authors.append(name)
    year = None
    for key in ("published-print", "published-online", "issued", "created"):
        parts = ((message.get(key) or {}).get("date-parts") or [[None]])
        if parts and parts[0] and parts[0][0]:
            year = parts[0][0]
            break
    result = {
        "title": next((_text(item) for item in message.get("title") or [] if _text(item)), ""),
        "authors": authors,
        "year": year,
        "venue": next(
            (_text(item) for item in message.get("container-title") or [] if _text(item)),
            _text(message.get("publisher")),
        ),
        "abstract": _strip_markup(message.get("abstract")),
        "doi": doi,
    }
    return {key: value for key, value in result.items() if _has_value(value)}


def lookup_openalex(doi=None, title=None):
    doi = normalize_doi(doi)
    params = {"select": OPENALEX_FIELDS, "per_page": 5}
    if doi:
        params["filter"] = f"doi:{doi}"
    elif title:
        params["search"] = title
    else:
        return {}
    try:
        data = _get_json(OPENALEX, params)
    except Exception as error:
        logger.info("OpenAlex lookup skipped: %s", type(error).__name__)
        return {}
    works = (data or {}).get("results") or []
    if doi:
        work = works[0] if works else None
    else:
        def score(item):
            candidate = item.get("title") or ""
            similarity = title_similarity(title, candidate)
            # Papers are often saved under a short name such as
            # "Multi-Agent-as-Judge.pdf" while the API returns the full title.
            query_key = _title_key(title)
            if len(query_key) >= 8 and _title_key(candidate).startswith(query_key):
                return max(similarity, 0.9)
            return similarity

        work = max(works, key=score, default=None)
        if work and score(work) < 0.9:
            work = None
    if not work:
        return {}
    source = ((work.get("primary_location") or {}).get("source") or {}).get("display_name")
    authors = [
        entry.get("author", {}).get("display_name")
        for entry in work.get("authorships") or []
        if _text(entry.get("author", {}).get("display_name"))
    ]
    result = {
        "title": _text(work.get("title")),
        "authors": authors,
        "year": work.get("publication_year"),
        "venue": _text(source),
        "abstract": _abstract_from_inverted(work.get("abstract_inverted_index")),
        "doi": normalize_doi(work.get("doi")),
        "citation_count": work.get("cited_by_count"),
    }
    return {key: value for key, value in result.items() if _has_value(value)}


def build_metadata_updates(metadata, path=None, *, overwrite=False):
    """Return only the metadata fields that should be written.

    PDF information is the weakest source, OpenAlex adds citation counts and
    abstracts, and Crossref wins for records where a DOI is known. Fields the
    user already filled are preserved unless ``overwrite`` is requested.
    """
    existing = metadata or {}
    pdf = extract_pdf_metadata(path)
    existing_doi = normalize_doi(existing.get("doi"))
    pdf_doi = normalize_doi(pdf.get("doi"))
    if pdf_doi and PLACEHOLDER_DOI.search(pdf_doi):
        pdf_doi = ""
    doi = existing_doi or pdf_doi
    filename = _text(existing.get("filename")) or (Path(path).name if path else "")
    search_title = (
        "" if _placeholder_title(existing.get("title"), filename) else _text(existing.get("title"))
    ) or _text(pdf.get("title")) or _filename_title(filename)

    crossref = lookup_crossref(doi) if doi else {}
    openalex = lookup_openalex(doi=doi, title=search_title) if doi or search_title else {}
    if not openalex and doi and search_title:
        # A DOI extracted from a PDF can be a placeholder or include trailing text.
        openalex = lookup_openalex(title=search_title)

    merged = {}
    origins = {}
    for origin, source in (("pdf", pdf), ("openalex", openalex), ("crossref", crossref)):
        for key, value in source.items():
            if _has_value(value):
                merged[key] = value
                origins[key] = origin
    if doi:
        confirmed = normalize_doi(crossref.get("doi")) or normalize_doi(openalex.get("doi"))
        if existing_doi:
            merged["doi"] = existing_doi
            origins["doi"] = "manual"
        else:
            merged["doi"] = confirmed or pdf_doi or doi
            origins["doi"] = (
                "crossref" if normalize_doi(crossref.get("doi"))
                else "openalex" if normalize_doi(openalex.get("doi"))
                else "pdf"
            )

    updates = {}
    for key in ("title", "authors", "year", "venue", "abstract", "doi", "citation_count"):
        if key not in merged:
            continue
        current = existing.get(key)
        if key == "title" and _placeholder_title(current, filename):
            current = None
        if overwrite or not _has_value(current):
            updates[key] = merged[key]
    if "authors" in updates and isinstance(updates["authors"], list):
        updates["author"] = "、".join(updates["authors"])
    if updates:
        updates["metadata_source"] = "+".join(
            dict.fromkeys(origins[key] for key in updates if key in origins)
        )
    updates["metadata_checked_at"] = datetime.now(timezone.utc).isoformat()
    return updates
