import re
from urllib.parse import quote, urljoin, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Query, Response


router = APIRouter(prefix="/api/online-papers")
OPENALEX = "https://api.openalex.org/works"
FIELDS = "id,title,doi,publication_year,authorships,primary_location,best_oa_location,locations,abstract_inverted_index"
PDF_HOSTS = {
    "arxiv.org", "export.arxiv.org", "aclanthology.org", "proceedings.mlr.press",
    "openaccess.thecvf.com", "pmc.ncbi.nlm.nih.gov", "europepmc.org", "acm.org",
    "dl.acm.org", "www.nature.com", "www.science.org", "www.frontiersin.org",
    "www.mdpi.com", "journals.plos.org", "link.springer.com",
}
DOI = re.compile(r"10\.\d{4,9}/\S+", re.IGNORECASE)
MAX_PDF_BYTES = 20 * 1024 * 1024


def openalex(url, params=None):
    try:
        response = httpx.get(url, params=params, timeout=12, follow_redirects=False)
        if response.status_code in {401, 403, 429}:
            raise HTTPException(status_code=503, detail="OpenAlex 匿名请求暂不可用或已达限额，请稍后重试。")
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail="OpenAlex 中没有找到这篇论文。")
        response.raise_for_status()
        return response.json()
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="OpenAlex 请求超时，请重试。") from error
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=502, detail="暂时无法连接 OpenAlex 或读取检索结果。") from error


def public_link(value):
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        return value if url.scheme == "https" and url.hostname and not url.username and not url.password else None
    except ValueError:
        return None


def trusted_pdf(value):
    if not public_link(value):
        return False
    try:
        url = urlsplit(value)
        return url.hostname in PDF_HOSTS and url.port in {None, 443}
    except ValueError:
        return False


def describe(work):
    locations = [work.get("best_oa_location"), work.get("primary_location"), *(work.get("locations") or [])]
    pdf_urls = list(dict.fromkeys(
        url for loc in locations if loc and loc.get("is_oa")
        if (url := public_link(loc.get("pdf_url")))
    ))
    doi = public_link(work.get("doi"))
    arxiv = re.fullmatch(r"https://doi\.org/10\.48550/arxiv\.([\w./-]+)", doi or "", re.IGNORECASE)
    if arxiv:
        pdf_urls.insert(0, "https://arxiv.org/pdf/" + arxiv[1])
    abstract = work.get("abstract_inverted_index") or {}
    words = sorted((index, word) for word, indices in abstract.items() for index in indices)
    return {
        "id": work["id"].rsplit("/", 1)[-1],
        "title": work.get("title") or "未命名论文",
        "year": work.get("publication_year"),
        "authors": [entry["author"]["display_name"] for entry in (work.get("authorships") or [])[:6]
                    if entry.get("author", {}).get("display_name")],
        "doi": doi,
        "source_url": doi or next((link for loc in locations if loc
                                   if (link := public_link(loc.get("landing_page_url")))), work["id"]),
        "pdf_url": pdf_urls[0] if pdf_urls else None,
        "pdf_candidates": [url for url in pdf_urls if trusted_pdf(url)][:4],
        "abstract": " ".join(word for _, word in words),
    }


@router.get("")
def search_papers(q: str = Query(min_length=2, max_length=500)):
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(status_code=422, detail="请输入标题、DOI 或主题。")
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", query, flags=re.IGNORECASE)
    params = {"select": FIELDS, "per_page": 10}
    if DOI.fullmatch(doi):
        params["filter"] = "doi:https://doi.org/" + doi.lower()
    else:
        params["search"] = query
    data = openalex(OPENALEX, params)
    papers = [describe(work) for work in data.get("results", []) if work.get("id")]
    for paper in papers:
        paper["can_download"] = bool(paper.pop("pdf_candidates"))
    return {"papers": papers}


def download_pdf(url):
    with httpx.Client(timeout=15, follow_redirects=False) as client:
        for _ in range(4):
            if not trusted_pdf(url):
                return None
            with client.stream("GET", url) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get("location", ""))
                    continue
                if not response.is_success:
                    return None
                data = bytearray()
                for chunk in response.iter_bytes(chunk_size=65536):
                    data.extend(chunk)
                    if len(data) > MAX_PDF_BYTES:
                        return None
                    if len(data) >= 1024 and b"%PDF-" not in data[:1024]:
                        return None
                return bytes(data) if b"%PDF-" in data[:1024] else None
    return None


@router.get("/{work_id}/pdf")
def get_paper_pdf(work_id: str):
    if not re.fullmatch(r"W\d{1,24}", work_id):
        raise HTTPException(status_code=422, detail="无效的 OpenAlex 论文编号。")
    work = describe(openalex(f"{OPENALEX}/{work_id}", {"select": FIELDS}))
    for url in work["pdf_candidates"]:
        try:
            pdf = download_pdf(url)
        except httpx.HTTPError:
            continue
        if pdf:
            filename = quote(work["title"][:120] + ".pdf", safe="")
            return Response(pdf, media_type="application/pdf", headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
                "X-Content-Type-Options": "nosniff",
            })
    raise HTTPException(status_code=404, detail="未能自动读取开放 PDF。可使用摘要，或从来源页面下载原件后手动上传。")
