import re
import unicodedata
from pathlib import Path

import jieba


DOI = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+")
TOKEN = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+|[a-z0-9]+(?:[._/-][a-z0-9]+)*|[\u3400-\u9fff]+")
STOP_WORDS = frozenset("""
the a an of in to for and or is are was were be it by with from how what which where does did
的 了 是 有 在 和 与 中 对 与否 吗 呢 什么 哪些 如何 请 哪个 多少 文献 论文 报告
""".split())


def normalized(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def terms(text: str):
    for match in TOKEN.finditer(normalized(text)):
        token = match.group()
        if "\u3400" <= token[0] <= "\u9fff":
            yield from (
                term for term in jieba.cut_for_search(token, HMM=False)
                if term not in STOP_WORDS
            )
        elif token not in STOP_WORDS:
            yield token.rstrip(".;:)")


def index_text(text: str) -> str:
    return " ".join(terms(text))


def match_expression(query: str) -> str:
    tokens = list(dict.fromkeys(terms(query)))[:32]
    # FTS syntax is generated exclusively from tokenizer output.
    return " OR ".join('"' + token + '"' for token in tokens)


def exact_document_match(query: str, metadata: dict) -> bool:
    query = normalized(query)
    title = metadata.get("title") or Path(metadata.get("filename", "")).stem
    title = " ".join(normalized(title).split())
    dois = {match.group().rstrip(".;:)") for match in DOI.finditer(query)}
    doi = DOI.search(normalized(metadata.get("doi") or ""))
    return bool(
        (doi and doi.group().rstrip(".;:)") in dois)
        or (title and query.strip() == title)
        or (len(title) >= 4 and re.search(r"(?<![a-z0-9])" + re.escape(title) + r"(?![a-z0-9])", query))
    )
