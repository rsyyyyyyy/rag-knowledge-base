import re
import unicodedata
from collections import Counter
from pathlib import Path

from knowledge_search import KnowledgeScope, default_folder_id


QUOTES = "\"'\x60“”‘’《》「」 "
STATUS_LABELS = {
    "queued": "等待入库", "processing": "正在入库", "failed": "入库失败",
    "no_text_extracted": "未提取到文本", "stored_only": "原件已保存",
}


def markdown_text(value):
    return re.sub(r"([\\\x60*_[\]<>~|])", r"\\\1", " ".join(str(value).split()))


def folder_path(folder, by_id):
    names = []
    seen = set()
    while folder and folder["id"] not in seen:
        seen.add(folder["id"])
        names.append(folder["name"])
        folder = by_id.get(folder.get("parent_id"))
    return "/".join(reversed(names))


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().strip(QUOTES).split())


def resolve_question_scope(question, plan, scope, service):
    folders = service.catalog.load("folders")
    by_id = {folder["id"]: folder for folder in folders}
    if plan.folder_names:
        selected = set()
        for name in plan.folder_names:
            key = normalized(name)
            hits = [folder for folder in folders
                    if key in (normalized(folder["name"]), normalized(folder_path(folder, by_id)))]
            if not hits:
                alias = re.sub(r"(?:文件夹|目录)$", "", key).strip(QUOTES)
                hits = [folder for folder in folders
                        if alias and alias in (normalized(folder["name"]), normalized(folder_path(folder, by_id)))]
            allowed = [folder for folder in hits
                       if scope.folder_ids is None or folder["id"] in scope.folder_ids]
            if not allowed:
                return scope, f"当前查询范围内没有找到名为「{markdown_text(name)}」的文件夹。"
            if len(allowed) > 1:
                paths = "\n".join("- " + markdown_text(folder_path(folder, by_id)) for folder in allowed[:30])
                return scope, "找到多个同名文件夹，请用完整路径指定一个。\n\n" + paths
            selected.add(allowed[0]["id"])
        scope = KnowledgeScope(document_ids=scope.document_ids, folder_ids=sorted(selected))

    documents = service._documents(scope)
    query = normalized(question)
    mentioned = {
        doc_id for doc_id, metadata in documents.items()
        if "." in (filename := metadata.get("filename") or "")
        and re.search(r"(?<![a-z0-9_.-])" + re.escape(normalized(filename)) + r"(?![a-z0-9_.-])", query)
    }
    if not plan.document_names and not mentioned:
        return scope, None
    resolved = set(mentioned)
    for name in plan.document_names:
        key = normalized(name)
        hits = {doc_id for doc_id, doc in documents.items() if key == normalized(doc.get("filename") or "")}
        if not hits:
            hits = {doc_id for doc_id, doc in documents.items()
                    if key and key in (normalized(doc.get("title") or ""),
                                        normalized(Path(doc.get("filename") or "").stem))}
        if len(hits) > 1:
            explicit = hits & mentioned
            if len(explicit) == 1:
                hits = explicit
        if not hits:
            return scope, f"当前查询范围内没有找到文献「{markdown_text(name)}」。"
        if len(hits) > 1:
            return scope, f"找到多条名为「{markdown_text(name)}」的文献记录，请指定所在文件夹。"
        resolved.update(hits)
    if not plan.document_names and len(mentioned) > 1:
        names = {normalized(documents[doc_id]["filename"]) for doc_id in mentioned}
        if len(names) != len(mentioned):
            return scope, "找到同名文献，请指定所在文件夹。"
    ordered = sorted(resolved, key=lambda doc_id: (
        query.find(normalized(documents[doc_id].get("filename") or ""))
        if normalized(documents[doc_id].get("filename") or "") in query else len(query),
        doc_id,
    ))
    return KnowledgeScope(document_ids=ordered, folder_ids=scope.folder_ids), None


def render_catalog_answer(plan, scope, service, *, listing=None):
    folders = service.catalog.load("folders")
    by_id = {folder["id"]: folder for folder in folders}
    default = default_folder_id(folders)
    if plan.route == "folders":
        documents = service._documents(scope)
        counts = Counter(doc.get("folder_id") or default for doc in documents.values())
        paths = sorted((folder_path(folder, by_id), counts[folder["id"]]) for folder in folders
                       if (scope.folder_ids is None or folder["id"] in scope.folder_ids)
                       and (scope.document_ids is None or folder["id"] in counts))
        if not paths:
            return "当前查询范围内没有文件夹。"
        headline = f"当前查询范围内有 **{len(paths)}** 个文件夹。"
        if plan.count_only:
            return headline
        if len(paths) > 30:
            headline += "以下列出前 30 个。"
        return headline + "\n\n" + "\n".join(
            f"- {markdown_text(path)}（直接收录 {count} 篇）" for path, count in paths[:30]
        )

    if listing is None:
        listing = service.session(scope).list_documents(limit=30)
    if plan.route == "file_status":
        if scope.document_ids is None:
            return "请提供要查询的文件名或文献标题。"
        rows = []
        for document in listing["documents"]:
            folder = by_id.get(document["folder_id"] or default)
            path = markdown_text(folder_path(folder, by_id)) if folder else "未归类"
            status = STATUS_LABELS.get(document["status"], "尚不可检索")
            state = "可检索" if document["searchable"] else status
            rows.append(f"- {markdown_text(document['filename'])} · {path} · {state}")
        if not rows:
            return "当前查询范围内没有匹配的文献记录。"
        return "当前范围内查到以下文件记录。\n\n" + "\n".join(rows)

    if scope.folder_ids and len(scope.folder_ids) == 1 and scope.folder_ids[0] in by_id:
        label = "文件夹「" + markdown_text(folder_path(by_id[scope.folder_ids[0]], by_id)) + "」"
    else:
        label = "当前知识库" if scope.folder_ids is None and scope.document_ids is None else "当前查询范围"
    count = listing["total"]
    if not count:
        return f"{label}目前没有直接收录的文献。"
    headline = f"{label}共收录 **{count}** 篇文献。"
    if plan.count_only:
        return headline
    rows = []
    for document in listing["documents"]:
        filename = markdown_text(document["filename"] or document["title"] or document["id"])
        status = STATUS_LABELS.get(document["status"], "尚不可检索")
        rows.append("- " + filename + ("" if document["searchable"] else f"（{status}）"))
    if count > len(rows):
        headline += f"以下为最近上传的 {len(rows)} 篇。"
    return headline + "\n\n" + "\n".join(rows)
